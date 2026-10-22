// language: JavaScript, file: server.js, runtime: Node.js 18+, deps: express, cors, axios, fs, path
// *watch for: Agnes API асинхронный — сначала создаём задачу, потом поллим по video_id*
// *watch for: видео скачивается на сервер, чтобы не было CORS и ссылка не протухала*

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== НАСТРОЙКИ ====================
// Вставь свой ключ с agnes-ai.com (Console -> API Keys)
const AGNES_API_KEY = "sk-Ikf50LYQMUZ3vjxwOySc5dpaJ2QSyZgSsJhZlS2XamkjxXc5";
const BASE_URL = "https://apihub.agnes-ai.com/v1";
const MODEL_NAME = "agnes-video-2.5-flash"; // бесплатная модель

// Создаём папку public, если её нет
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

// ==================== 1. СОЗДАНИЕ ЗАДАЧИ ====================
app.post('/api/generate', async (req, res) => {
    try {
        const { prompt, duration } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: "prompt is required" });
        }

        // Agnes принимает строку секунд: "5", "10" и т.д.
        // Максимум для flash-модели — 12 секунд
        const seconds = String(Math.min(Number(duration) || 5, 12));

        console.log(`[Generate] prompt="${prompt}", duration=${seconds}s`);

        const response = await axios.post(`${BASE_URL}/videos`, {
            model: MODEL_NAME,
            prompt: prompt,
            seconds: seconds,
            mode: "text",           // text -> видео
            size: "720P",           // бесплатная модель только 720P
            aspect_ratio: "16:9"    // 16:9 / 9:16 / 1:1
        }, {
            headers: {
                'Authorization': `Bearer ${AGNES_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 60000 // 60 секунд таймаут на создание задачи
        });

        // API возвращает video_id (может быть в разных полях)
        const videoId = response.data.video_id || response.data.id || response.data.task_id;

        if (!videoId) {
            console.error("[Generate] no video_id in response:", response.data);
            return res.status(500).json({ error: "no video_id in API response" });
        }

        console.log(`[Generate] task created: ${videoId}`);
        res.json({ video_id: videoId });

    } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
        console.error("[Generate] error:", errMsg);
        res.status(500).json({ error: errMsg });
    }
});

// ==================== 2. ПРОВЕРКА СТАТУСА ====================
app.get('/api/status/:videoId', async (req, res) => {
    try {
        const { videoId } = req.params;

        // Поллинг статуса
        const response = await axios.get(`https://apihub.agnes-ai.com/agnesapi`, {
            params: {
                video_id: videoId,
                model_name: MODEL_NAME
            },
            headers: {
                'Authorization': `Bearer ${AGNES_API_KEY}`
            },
            timeout: 30000
        });

        const data = response.data;
        const status = data.status || data.task_status;

        console.log(`[Status] ${videoId}: ${status}`);

        if (status === 'completed' || status === 'succeeded' || status === 'success') {
            // Скачиваем видео локально, чтобы не было CORS и протухших ссылок
            const remoteUrl = data.url || data.video_url || data.output?.url;
            
            if (!remoteUrl) {
                return res.json({ status: 'failed', error: 'no video url in response' });
            }

            try {
                const videoRes = await axios.get(remoteUrl, {
                    responseType: 'arraybuffer',
                    timeout: 120000 // 2 минуты на скачивание
                });

                const fileName = `video_${videoId}.mp4`;
                const filePath = path.join(publicDir, fileName);
                fs.writeFileSync(filePath, videoRes.data);

                console.log(`[Status] video saved: ${fileName} (${videoRes.data.byteLength} bytes)`);
                return res.json({ status: 'completed', videoUrl: `/${fileName}` });

            } catch (downloadErr) {
                console.error("[Status] download failed:", downloadErr.message);
                // Если скачать не удалось — отдаём прямую ссылку (может не работать из-за CORS)
                return res.json({ status: 'completed', videoUrl: remoteUrl, direct: true });
            }

        } else if (status === 'failed' || status === 'error') {
            const errMsg = data.error?.message || data.message || 'generation failed';
            return res.json({ status: 'failed', error: errMsg });

        } else {
            // В процессе
            return res.json({
                status: 'pending',
                progress: data.progress || 0,
                raw_status: status
            });
        }

    } catch (e) {
        const errMsg = e.response?.data?.error?.message || e.message;
        console.error("[Status] error:", errMsg);
        res.status(500).json({ error: errMsg });
    }
});

// ==================== 3. РАЗДАЧА СТАТИКИ ====================
app.use(express.static(publicDir));

// Healthcheck
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ==================== 4. ЗАПУСК ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n=================================`);
    console.log(`Resora 2 · Agnes AI`);
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Model:  ${MODEL_NAME}`);
    console.log(`=================================\n`);
    
    if (AGNES_API_KEY === "sk-Ikf50LYQMUZ3vjxwOySc5dpaJ2QSyZgSsJhZlS2XamkjxXc5") {
        console.warn("⚠️  ВНИМАНИЕ: не вставлен API ключ Agnes!");
        console.warn("   Зарегистрируйся на agnes-ai.com и вставь ключ в server.js\n");
    }
});