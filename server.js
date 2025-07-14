import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --- ОБЩАЯ НАСТРОЙКА ---
if (!process.env.GEMINI_API_KEY || !process.env.TMDB_API_KEY) {
  throw new Error("Ключи GEMINI_API_KEY и TMDB_API_KEY должны быть в файле .env");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TMDB_API_KEY = process.env.TMDB_API_KEY;

// Модель для диалога с новой, улучшенной инструкцией
const conversationalModel = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: `Ты — AI-помощник "Синема-сомелье". Твоя задача — вести диалог с пользователем, чтобы собрать его предпочтения. Задавай уточняющие вопросы про жанр, тему, атмосферу, финал и т.д.
ВАЖНОЕ ПРАВИЛО: Когда ты считаешь, что собрал достаточно информации, твой ответ ДОЛЖЕН содержать специальный блок, в котором ты резюмируешь все пожелания в один поисковый запрос.
Пример: "Отлично, я понял. Ищу варианты... 推薦{"query": "драма о борьбе за права роботов в футуристическом обществе со средним по тональности финалом"}"
Если ты еще не готов рекомендовать, просто задавай уточняющий вопрос без этого блока.`,
});

// Модель для обычного и креативного поиска
const searchModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });


// --- 1. ЭНДПОИНТ ДЛЯ "ПРОСТОГО ПОИСКА" ---
app.post('/api/search/simple', async (req, res) => {
  console.log('\n--- ЗАПРОС [SIMPLE] ---');
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'Описание не может быть пустым' });
    const finalRankedMovies = await findMoviesByCrossCheck(description, 'simple');
    res.json(finalRankedMovies);
  } catch (error) {
    console.error('Ошибка на сервере [SIMPLE]:', error);
    res.status(500).json({ error: 'Произошла внутренняя ошибка сервера' });
  }
});

// --- 2. ЭНДПОИНТ ДЛЯ "КРЕАТИВНОГО ПОИСКА" ---
app.post('/api/search/creative', async (req, res) => {
  console.log('\n--- ЗАПРОС [CREATIVE] ---');
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'Описание не может быть пустым' });
    const finalRankedMovies = await findMoviesByCrossCheck(description, 'creative');
    res.json(finalRankedMovies);
  } catch (error) {
    console.error('Ошибка на сервере [CREATIVE]:', error);
    res.status(500).json({ error: 'Произошла внутренняя ошибка сервера' });
  }
});

// --- 3. ЭНДПОИНТ ДЛЯ "ДИАЛОГА" (ПОЛНОСТЬЮ ПЕРЕРАБОТАННЫЙ) ---
app.post('/api/search/conversational', async (req, res) => {
  console.log('\n--- ЗАПРОС [CONVERSATIONAL] ---');
  try {
    let clientHistory = req.body.history;

    if (!clientHistory || !Array.isArray(clientHistory)) {
      return res.status(400).json({ error: 'История чата не предоставлена.' });
    }

    if (clientHistory.length > 0 && clientHistory[0].role === 'bot') {
      clientHistory = clientHistory.slice(1);
    }

    if (clientHistory.length === 0) {
      return res.json({ reply: "Пожалуйста, опишите, что бы вы хотели посмотреть." });
    }

    const geminiHistory = clientHistory.map(msg => ({
      role: msg.role === 'user' ? 'user' : 'model',
      parts: [{ text: msg.text }],
    }));

    const latestUserMessage = geminiHistory.pop();

    const chat = conversationalModel.startChat({
      history: geminiHistory,
    });

    const result = await chat.sendMessage(latestUserMessage.parts[0].text);
    const response = await result.response;
    const botReply = response.text();

    console.log("Ответ от Gemini (диалог):", botReply);

    const recommendationMarker = '推薦';
    if (botReply.includes(recommendationMarker)) {
      console.log("Обнаружен маркер рекомендации. Запускаем полноценный поиск...");

      const jsonStringMatch = botReply.match(/\{.*\}/s);
      if (jsonStringMatch) {
        const searchParameters = JSON.parse(jsonStringMatch[0]);
        const userQuery = searchParameters.query;

        if (!userQuery) {
          throw new Error("AI не вернул поисковый запрос в JSON.");
        }

        console.log(`Получен итоговый запрос из диалога: "${userQuery}"`);
        // Запускаем нашу мощную функцию поиска с собранным запросом и в креативном режиме!
        const finalRankedMovies = await findMoviesByCrossCheck(userQuery, 'creative');

        // Отправляем на фронтенд не просто ответ, а массив фильмов
        res.json(finalRankedMovies);

      } else {
        // Если маркер есть, но JSON не найден, возвращаем ошибку
        res.json({ reply: "Кажется, я пытался предложить фильм, но что-то пошло не так с форматированием. Попробуем еще раз?" });
      }
    } else {
      // Если маркера нет, просто возвращаем ответ-вопрос от AI
      res.json({ reply: botReply });
    }

  } catch (error) {
    console.error('Ошибка на сервере [CONVERSATIONAL]:', error);
    res.status(500).json({ error: 'Произошла внутренняя ошибка сервера в режиме диалога' });
  }
});


// --- ОБЩИЕ ФУНКЦИИ ---

async function findMoviesByCrossCheck(description, searchType) {
  const geminiSuggestions = await getInitialSuggestions(description, searchType);
  console.log(`1. Gemini предложил ${geminiSuggestions.length} вариантов.`);
  if (geminiSuggestions.length === 0) return [];

  const titles = geminiSuggestions.map(s => s.title);
  console.log('2. Ищу кандидатов в TMDb...');
  const tmdbCandidates = await findTmdbCandidates(titles);
  console.log(`3. Найдено ${tmdbCandidates.length} уникальных кандидатов в TMDb.`);
  if (tmdbCandidates.length === 0) return [];

  const candidatesWithJustification = tmdbCandidates.map(movie => {
    const movieOriginalTitleLower = movie.original_title.toLowerCase();

    const originalSuggestion = geminiSuggestions.find(s => {
      const suggestionTitleLower = s.title.toLowerCase();
      return movieOriginalTitleLower.includes(suggestionTitleLower) || suggestionTitleLower.includes(movieOriginalTitleLower);
    });

    return {
      ...movie,
      justification: originalSuggestion ? originalSuggestion.justification : null
    };
  });

  console.log('4. Отправляю кандидатов в Gemini для финального ранжирования...');
  const finalRankedMovies = await getFinalRanking(description, candidatesWithJustification);
  console.log(`5. Отправляю топ-${finalRankedMovies.length} фильмов.`);

  return finalRankedMovies;
}

async function getInitialSuggestions(description, searchType) {
  let prompt;
  if (searchType === 'creative') {
    prompt = `Ты — гениальный и эрудированный кинокритик-концептуалист. Твоя задача — найти фильмы с похожей ГЛАВНОЙ ИДЕЕЙ, но из СОВЕРШЕННО ДРУГИХ ЖАНРОВ.

    1.  Проанализируй запрос пользователя и выдели в нем центральную, абстрактную тему (например, "бунт против системы", "потеря памяти и поиск себя", "одиночество в толпе").
    2.  ПОЛНОСТЬЮ ИГНОРИРУЙ жанр и стилистику фильма, который привел в пример пользователь.
    3.  Подбери до 5 фильмов, которые исследуют эту же центральную тему, но в абсолютно ином сеттинге (другая эпоха, другой жанр и т.д.).
    4.  В поле "justification" кратко и ярко объясни, какая именно общая идея связывает предложенный тобой фильм с запросом пользователя.

    ПРИМЕР РАБОТЫ:
    - ЗАПРОС ПОЛЬЗОВАТЕЛЯ: "фильм как Матрица, про борьбу против системы"
    - ТВОЙ РЕЗУЛЬТАТ: [{"title": "One Flew Over the Cuckoo's Nest", "justification": "Как и 'Матрица', это мощная история о восстании свободной личности против бездушной, репрессивной системы, представленной здесь стенами психиатрической лечебницы."}]

    Отвечай СТРОГО валидным JSON-массивом объектов формата [{"title": "АНГЛИЙСКОЕ НАЗВАНИЕ", "justification": "Твое концептуальное объяснение"}].

    ЗАПРОС ПОЛЬЗОВАТЕЛЯ: "${description}"`;

  } else {
    prompt = `Проанализируй запрос и предложи до 7 названий фильмов (только английские названия). Отвечай строго валидным JSON-массивом объектов формата [{"title": "АНГЛИЙСКОЕ НАЗВАНИЕ"}]. Пример: [{"title": "The Matrix"}]. Запрос: "${description}"`;
  }

  try {
    const result = await searchModel.generateContent(prompt);
    const response = await result.response;
    const rawText = response.text().match(/\[.*\]/s)[0];
    return JSON.parse(rawText);
  } catch (error) {
    console.error("Ошибка на шаге 1 (предложения от Gemini):", error);
    return [];
  }
}

async function findTmdbCandidates(titles) {
  const candidates = new Map();
  const searchPromises = titles.map(title =>
    fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&language=ru-RU&include_adult=false`)
      .then(res => res.json())
      .catch(err => {
        console.error(`Ошибка при поиске "${title}":`, err);
        return { results: [] };
      })
  );

  const searchResults = await Promise.all(searchPromises);

  for (const data of searchResults) {
    if (data.results && data.results.length > 0) {
      data.results.slice(0, 3).forEach(movie => {
        if (!candidates.has(movie.id)) {
          candidates.set(movie.id, movie);
        }
      });
    }
  }
  return Array.from(candidates.values());
}

async function getFinalRanking(originalDescription, movies) {
  const simplifiedList = movies.map(m => ({ id: m.id, title: m.title, overview: m.overview }));
  const prompt = `Ты — финальный фильтр. Проанализируй изначальный запрос пользователя и выбери из предоставленного списка фильмов 5 самых подходящих. Отвечай строго валидным JSON-объектом формата {"recommendations": [id1, id2, id3, id4, id5]}, где id — это числовой ID фильма. Расположи ID в порядке от самого релевантного к наименее. Исходный запрос: "${originalDescription}". Список фильмов: ${JSON.stringify(simplifiedList)}`;

  try {
    const result = await searchModel.generateContent(prompt);
    const response = await result.response;
    const rawText = response.text().match(/\{.*\}/s)[0];
    const rankedIds = JSON.parse(rawText).recommendations;

    return rankedIds.map(id => {
      const movie = movies.find(m => m.id === id);
      return {
        title: movie.title,
        year: movie.release_date ? movie.release_date.substring(0, 4) : 'N/A',
        overview: movie.overview,
        poster_path: movie.poster_path,
        justification: movie.justification || null
      };
    });
  } catch (error) {
    console.error("Ошибка на шаге 4 (финальное ранжирование):", error);
    return movies.slice(0, 5).map(movie => ({
      title: movie.title,
      year: movie.release_date ? movie.release_date.substring(0, 4) : 'N/A',
      overview: movie.overview,
      poster_path: movie.poster_path,
      justification: movie.justification || null
    }));
  }
}

// --- ЗАПУСК СЕРВЕРА ---
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Сервер с тремя эндпоинтами запущен на порту ${PORT}`);
});