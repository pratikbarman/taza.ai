const express = require('express');
const http = require('http');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require("fs")
const winston = require('winston');
const NodeCache = require("node-cache");
const expressWinston = require('express-winston');

// Function to get a formatted date string
function getFormattedDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0'); // Months are zero-based
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Define log directory and files with date
const logDir = path.join(__dirname, 'logs');
const dateStr = getFormattedDate();
const errorLogPath = path.join(logDir, `error-${dateStr}.log`);
const combinedLogPath = path.join(logDir, `combined-${dateStr}.log`);

// Function to check and create directory if it does not exist
function ensureLogDirectoryExists(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true }); // Create directory and any missing parent directories
    }
}

// Ensure the log directory exists
ensureLogDirectoryExists(logDir);

// Create the Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: errorLogPath, level: 'error' }),
        new winston.transports.File({ filename: combinedLogPath })
    ]
});

const myCache = new NodeCache({ stdTTL: 86400 });
myCache.flushAll()

const app = express();
const port = 3000;

const server = http.createServer(app);
server.setTimeout(600000); // 10 minutes


let browser;

app.use(express.json());



// Middleware for logging requests
// Middleware to log the real client IP address
app.use(expressWinston.logger({
    winstonInstance: logger,
    meta: false, // Do not log meta data
    msg: (req, res) => {
        // Get the real client IP address
        const clientIp = req.headers['cf-connecting-ip'] || req.ip;
        return `HTTP ${req.method} ${req.url} - IP ${clientIp}`;
    },
    expressFormat: false,
    colorize: false
}));

// Your routes go here

// Middleware for logging errors
app.use(expressWinston.errorLogger({
    winstonInstance: logger
}));



const getYouTubeVideoUrl = (url) => {
    let regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    let match = url.match(regExp);
    return (match && match[7].length == 11) ? match[7] : false;
}

const launchBrowser = async () => {
    try {
        if (!browser) {
            browser = await puppeteer.launch({
                headless: true,
                userDataDir: path.join(__dirname, "userData")
            });
        }
    } catch (error) {
        logger.error('Error launching browser:', { message: error.message, stack: error.stack })
    }
};

const shutdown = async () => {
    try {
        if (browser) {
            await browser.close();
        }
    } catch (error) {
        logger.error('Error closing browser:', { message: error.message, stack: error.stack })
    }
};

async function puppeteerMiddleware(req, res, next) {
    await launchBrowser();
    next();
}

app.use(async (req, res, next) => {
    req.setTimeout(600000);
    res.setTimeout(600000);
    next();
});

app.get('/optimize', puppeteerMiddleware, async (req, res) => {
    const { youtube_url, additional_context, voices_selection, output_language } = req.query;
    const videoId = getYouTubeVideoUrl(youtube_url)

    try {

        if (!videoId) {
            return res.status(400).json({ "message": "Please enter correct youtube Video URL!" });
        }

        if (myCache.has(`video_${videoId}`)) {
            return res.json(myCache.get(`video_${videoId}`));
        }

        const page = await browser.newPage();

        req.on('close', () => {
            if (!page.isClosed()) {
                myCache.set(`progress_${videoId}`, { "status": "disconnected" })
                page.close();
            }
        });

        await page.setViewport({ width: 1280, height: 720 });
        await page.goto('https://app.taja.ai/optimize', { timeout: 180000 });

        if (page.url() === "https://app.taja.ai/signin") {
            await page.waitForSelector('#email');
            await page.type("#email", "tfluxtech@gmail.com");
            await page.waitForSelector('#password');
            await page.type("#password", "Baba@5566");

            await Promise.all([
                page.waitForNavigation(),
                page.click('button[type="submit"]')
            ]);
            logger.info("Taja.ai Login Successful!");
        }

        if (page.url() !== "https://app.taja.ai/dashboard" && page.url() !== "https://app.taja.ai/optimize") {
            if (page.url() === "https://app.taja.ai/dashboard") {
                await page.goto("https://app.taja.ai/optimize", { timeout: 180000 });
            } else {
                throw new Error("Unexpected URL: " + page.url());
            }
        }

        const postData = {
            youtube_url,
            additional_context,
            voices_selection,
            output_language
        };


        logger.info("Video optimization started");
        myCache.set(`progress_${videoId}`, { "status": "started" })

        const result = await page.evaluate(async (data) => {
            const response = await fetch('https://app.taja.ai/api/proxy/videos/full-optimize', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseBody = await response.json();
            return responseBody;
        }, postData)

        logger.info("Video optimization completed")

        myCache.set(`progress_${videoId}`, { "status": "complete" })
        myCache.set(`video_${videoId}`, result)

        await page.close();
        res.json(result);

    } catch (error) {
        myCache.set(`progress_${videoId}`, { "status": "failed" })
        logger.error('Error to Video optimization:', { message: error.message, stack: error.stack })
        res.status(400).json({ "message": "An error occurred: " + error.message });
    }
});

app.get('/status', async (req, res) => {
    const { youtube_url } = req.query;
    try {
        const videoId = getYouTubeVideoUrl(youtube_url)
        if (!videoId) {
            return res.status(400).json({ "message": "Please enter correct youtube Video URL!" });
        }

        if (myCache.has(`progress_${videoId}`)) {
            res.json(myCache.get(`progress_${videoId}`));
        } else {
            res.json({ status: "notfound" });
        }

    } catch (error) {
        logger.error('Error status route:', { message: error.message, stack: error.stack })
        res.status(400).json({ "message": "An error occurred: " + error.message });
    }

})

app.get('/', async (req, res) => {
    res.json({ message: "Server running..." })
})


server.listen(port, () => {
    logger.info(`Server running on http://localhost:${port}`);
});

process.on('SIGINT', async () => {
    logger.info('Server is shutting down...');
    await shutdown();
    server.close(() => {
        logger.info('Server closed.');
        process.exit(0);
    });
});