const express = require('express');
const http = require('http');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require("fs")
const winston = require('winston');
const NodeCache = require("node-cache");
const expressWinston = require('express-winston');
const crypto = require('crypto'); // For generating hash

const myCache = new NodeCache({ stdTTL: 86400 });
myCache.flushAll()



const app = express();
const port = 3000;

const server = http.createServer(app);
server.setTimeout(600000); // 10 minutes

let browser;
let loggedInPage;

const launchBrowser = async () => {
    try {
        if (!browser) {
            browser = await puppeteer.launch({
                headless: false,
                userDataDir: path.join(__dirname, "userData"),
            });
        }
    } catch (error) {
        logger.error('Error launching browser:', { message: error.message, stack: error.stack });
    }
};

const closePage = async () => {
    try {
        if (loggedInPage && !loggedInPage?.isClosed()) {
            loggedInPage = null;
            await loggedInPage.close();
        }
    } catch (error) {
        logger.error('Error launching browser:', { message: error.message, stack: error.stack });
    }
}

const shutdown = async () => {
    try {
        if (browser) {
            await browser.close();
        }
        await closePage();
    } catch (error) {
        logger.error('Error closing browser:', { message: error.message, stack: error.stack })
    }
};

const getYouTubeVideoUrl = (url) => {
    let regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    let match = url.match(regExp);
    return (match && match[7].length == 11) ? match[7] : false;
}

const getCacheName = (id, additional_context, voices_selection, output_language) => {
    const dataToHash = id +
        (additional_context || '') +
        (voices_selection ? voices_selection.join(',') : '') +
        (output_language || '');
    return crypto.createHash('md5').update(dataToHash).digest('hex');
}

/**
 * 
 * @param {*} page 
 * @returns 
 */
const login = async () => {
    try {
        if (!loggedInPage || loggedInPage.isClosed()) {
            loggedInPage = await browser.newPage();
            await loggedInPage.setViewport({ width: 1280, height: 720 });

            await loggedInPage.goto('https://app.taja.ai/optimize', { timeout: 180000 });

            // If not logged in, perform login
            if (loggedInPage.url() === "https://app.taja.ai/signin") {
                await loggedInPage.waitForSelector('#email');
                await loggedInPage.type("#email", "tfluxtech@gmail.com");
                await loggedInPage.waitForSelector('#password');
                await loggedInPage.type("#password", "Baba@821088");

                await Promise.all([
                    loggedInPage.waitForNavigation(),
                    loggedInPage.click('button[type="submit"]')
                ]);
                logger.info("Taja.ai Login Successful!");
            }

            // Navigate to the optimize page if not already there
            if (loggedInPage.url() !== "https://app.taja.ai/dashboard" &&
                loggedInPage.url() !== "https://app.taja.ai/optimize") {
                if (loggedInPage.url() === "https://app.taja.ai/dashboard") {
                    await loggedInPage.goto("https://app.taja.ai/optimize", { timeout: 180000 });
                } else {
                    throw new Error("Unexpected URL: " + loggedInPage.url());
                }
            }
        }

        return loggedInPage; // Return the logged-in page
    } catch (error) {
        logger.error('Login error:', { message: error.message, stack: error.stack });
        throw error;
    }
};


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





app.use(express.json());


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


app.use(express.static(path.join(__dirname, 'public')));

// Middleware to ensure browser is launched and user is logged in
async function puppeteerMiddleware(req, res, next) {
    try {
        await launchBrowser();
        await login();
        next();
    } catch (error) {
        res.status(500).json({ message: 'Error initializing Puppeteer: ' + error.message });
    }
}

app.use(async (req, res, next) => {
    req.setTimeout(600000);
    res.setTimeout(600000);
    next();
});

app.get('/', async (req, res) => {
    res.json({ message: "Server running..." })
})


app.get("/youtube-generate-thumbnails", puppeteerMiddleware, async (req, res) => {

    const { selected_title, video_id, with_caption } = req.query;

    try {

        const page = await login(); // Use the logged-in page

        const with_caption_in_images = (with_caption == true) ? true : false;

        const postData = {
            selected_title,
            video_id,
            with_caption_in_images
        }


        const result = await page.evaluate(async (data) => {
            const response = await fetch('https://app.taja.ai/api/proxy/videos/youtube-thumbnails', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                await closePage();
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseBody = await response.json();
            return responseBody;
        }, postData)


        const { youtube_optimized_thumbnails, ...optimizeResult } = result;

        const { youtube_id, additional_context, voices, output_language } = optimizeResult;


        // Safely extract thumbnail URLs if youtube_optimized_thumbnails is not null or undefined
        const thumbnails = youtube_optimized_thumbnails?.youtube_optimized_thumbnails
            ? youtube_optimized_thumbnails.youtube_optimized_thumbnails.map(item => item.thumbnail_url)
            : [];

        // Add thumbnails to optimizeResult
        optimizeResult.youtube_optimized_thumbnails = thumbnails;

        myCache.set(getCacheName(youtube_id, additional_context, voices, output_language), optimizeResult)



        res.json(optimizeResult);

    } catch (error) {
        logger.error('Error status route:', { message: error.message, stack: error.stack })
        res.status(500).json({ message: error.message })
    }


})

app.get('/youtube-titles-ranked', puppeteerMiddleware, async (req, res) => {
    const { selected_title, video_id } = req.query;

    try {

        const page = await login(); // Use the logged-in page

        const postData = {
            selected_title,
            video_id
        }


        const result = await page.evaluate(async (data) => {
            const response = await fetch('https://app.taja.ai/api/proxy/videos/youtube-titles-ranked', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                await closePage();
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseBody = await response.json();
            return responseBody;
        }, postData)


        const { youtube_optimized_thumbnails, ...optimizeResult } = result;

        const { youtube_id, additional_context, voices, output_language } = optimizeResult;

        myCache.set(getCacheName(youtube_id, additional_context, voices, output_language), optimizeResult)



        res.json(optimizeResult);

    } catch (error) {
        logger.error('Error status route:', { message: error.message, stack: error.stack })
        res.status(500).json({ message: error.message })
    }


});

app.get('/youtube-tags', puppeteerMiddleware, async (req, res) => {
    const { selected_title, video_id } = req.query;

    try {

        const page = await login(); // Use the logged-in page

        const postData = {
            selected_title,
            video_id
        }


        const result = await page.evaluate(async (data) => {
            const response = await fetch('https://app.taja.ai/api/proxy/videos/youtube-tags', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                await closePage();
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseBody = await response.json();
            return responseBody;
        }, postData)


        const { youtube_optimized_thumbnails, ...optimizeResult } = result;

        const { youtube_id, additional_context, voices, output_language } = optimizeResult;

        myCache.set(getCacheName(youtube_id, additional_context, voices, output_language), optimizeResult)



        res.json(optimizeResult);

    } catch (error) {
        logger.error('Error status route:', { message: error.message, stack: error.stack })
        res.status(500).json({ message: error.message })
    }


});



app.get('/youtube-description', puppeteerMiddleware, async (req, res) => {
    const { selected_title, video_id } = req.query;

    try {

        const page = await login(); // Use the logged-in page

        const postData = {
            selected_title,
            video_id
        }


        const result = await page.evaluate(async (data) => {
            const response = await fetch('https://app.taja.ai/api/proxy/videos/youtube-description', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                await closePage();
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseBody = await response.json();
            return responseBody;
        }, postData)


        const { youtube_optimized_thumbnails, ...optimizeResult } = result;

        const { youtube_id, additional_context, voices, output_language } = optimizeResult;

        myCache.set(getCacheName(youtube_id, additional_context, voices, output_language), optimizeResult)



        res.json(optimizeResult);

    } catch (error) {
        logger.error('Error status route:', { message: error.message, stack: error.stack })
        res.status(500).json({ message: error.message })
    }


});


app.get("/youtube-description-chapters-tags", puppeteerMiddleware, async (req, res) => {

    const { selected_title, video_id } = req.query;

    try {

        const page = await login(); // Use the logged-in page

        const postData = {
            selected_title,
            video_id
        }


        const result = await page.evaluate(async (data) => {
            const response = await fetch('https://app.taja.ai/api/proxy/videos/youtube-description-chapters-tags', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                await closePage();
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseBody = await response.json();
            return responseBody;
        }, postData)


        const { youtube_optimized_thumbnails, ...optimizeResult } = result;

        const { youtube_id, additional_context, voices, output_language } = optimizeResult;

        myCache.set(getCacheName(youtube_id, additional_context, voices, output_language), optimizeResult)



        res.json(optimizeResult);

    } catch (error) {
        logger.error('Error status route:', { message: error.message, stack: error.stack })
        res.status(500).json({ message: error.message })

    }

})

app.get('/optimize', puppeteerMiddleware, async (req, res) => {
    const { youtube_url, additional_context, voices_selection, output_language } = req.query;
    const videoId = getYouTubeVideoUrl(youtube_url)

    try {

        if (!videoId) {
            return res.status(400).json({ "message": "Please enter correct youtube Video URL!" });
        }

        const cacheName = getCacheName(videoId, additional_context, voices_selection, output_language)

        if (myCache.has(cacheName)) {
            return res.json(myCache.get(cacheName));
        }

        const page = await login(); // Use the logged-in page

        req.on('close', () => {
            if (!page.isClosed()) {
                myCache.set(`progress_${videoId}`, { "status": "disconnected" })
            }
        });

        await page.setViewport({ width: 1280, height: 720 });
        await login(page)

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
                await closePage();
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseBody = await response.json();
            return responseBody;
        }, postData)

        logger.info("Video optimization completed")

        myCache.set(`progress_${videoId}`, { "status": "complete" })


        const { youtube_optimized_thumbnails, ...optimizeResult } = result;

        myCache.set(cacheName, optimizeResult)


        res.json(optimizeResult);

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