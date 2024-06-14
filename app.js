const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const winston = require('winston');
const NodeCache = require("node-cache");
const expressWinston = require('express-winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: path.join(__dirname, 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join(__dirname, 'combined.log') })
    ]
});

const myCache = new NodeCache({ stdTTL: 86400 });
myCache.flushAll()

const app = express();
const port = 3000;

let browser;

app.use(express.json());



// Middleware for logging requests
app.use(expressWinston.logger({
    winstonInstance: logger,
    meta: true,
    msg: "HTTP {{req.method}} {{req.url}}",
    expressFormat: true,
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
        console.error("Failed Launce Puppeter",error)
    }
};

const shutdown = async () => {
    try {
        if (browser) {
            await browser.close();
        }
    } catch (error) {
        logger.error(error);
    }
};


 app.use(async (req, res, next) => {
    await launchBrowser();
    next();
});

app.get('/optimize', async (req, res) => {
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


        page.on('request', async (request) => {
            if (request.url() === "https://app.taja.ai/api/proxy/videos/full-optimize") {
                try {
                    logger.info("Video status poll started!");
                    const intervalSeconds = 2;
                    let statusResult = { status: "notfound" };

                    while (!page.isClosed() && statusResult.status !== "complete") {
                        // Check cache for video status if necessary
                        if (myCache.get(`progress_${videoId}`)?.status === "complete") {
                            console.log("Video status poll completed from cache!");
                            break;
                        }
                        statusResult = await page.evaluate(async (url) => {
                            try {
                                const response = await fetch(`https://app.taja.ai/api/proxy/videos/status?youtube_url=${url}`);
                                if (!response.ok) {
                                    throw new Error(`HTTP error! status: ${response.status}`);
                                }
                                const responseBody = await response.json();
                                return responseBody;
                            } catch (error) {
                                return { status: 'error', message: error.message };
                            }
                        }, youtube_url);
                        // Update cache with the latest status
                        myCache.set(`progress_${videoId}`, statusResult);
                        if (statusResult.status !== "complete") {
                            await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
                        } else {
                            logger.info("Video status poll completed!");
                        }
                    }

                } catch (error) {
                    logger.error(error);
                }
            }
        });


        logger.info("Video optimization started");

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
        myCache.set(`progress_${videoId}`, { "status": "complete" })
        logger.error(error)
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
        logger.error(error)
        res.status(400).json({ "message": "An error occurred: " + error.message });
    }

})

app.get('/', async (req, res) => {
    res.json({ message: "Server running..." })
})

const server = app.listen(port, () => {
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