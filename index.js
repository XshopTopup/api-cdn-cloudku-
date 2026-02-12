require('dotenv').config();
const express = require('express');
const { createClient } = require('@libsql/client');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { uploadToMultipleProviders } = require('./lib/uploader');
const githubService = require('./lib/github'); 

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, './views'));

let dbClient = null;
const getDB = () => {
    if (!dbClient) {
        dbClient = createClient({
            url: process.env.TURSO_DATABASE_URL,
            authToken: process.env.TURSO_AUTH_TOKEN,
        });
    }
    return dbClient;
};

// Menggunakan konfigurasi multer yang sudah ada
const upload = multer({ 
    dest: '/tmp/uploads/',
    limits: { fileSize: 200 * 1024 * 1024 }
});

const getFetch = async () => {
    const fetchModule = await import('node-fetch');
    return fetchModule.default;
};

function generateRandomString(length = 6) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomBytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        result += chars[randomBytes[i] % chars.length];
    }
    return result;
}

const initDB = async () => {
    const db = getDB();
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                filename TEXT UNIQUE NOT NULL,
                originalName TEXT NOT NULL,
                size INTEGER NOT NULL,
                mimetype TEXT,
                uploadDate DATETIME DEFAULT CURRENT_TIMESTAMP,
                cloudSkyUrl TEXT,
                catboxUrl TEXT,
                primaryProvider TEXT NOT NULL,
                publicUrl TEXT NOT NULL
            )
        `);
        console.log('✅ Database initialized');
    } catch (err) {
        console.error('❌ DB Init Error:', err);
    }
};

let isInitialized = false;
app.use(async (req, res, next) => {
    if (!isInitialized) {
        await initDB();
        isInitialized = true;
    }
    next();
});

// --- EXISTING ROUTES ---
/*
app.get('/', (req, res) => {
    res.render('index', { uploadedUrl: null, uploadedFile: null });
});

app.get('/docs', (req, res) => {
    res.render('docs');
});*/

app.get('/', (req, res) => {
    const currentDomain = req.hostname;

    res.render('index', { 
        domainName: currentDomain,
        errorCode: 'DNS_PROBE_FINISHED_NXDOMAIN' 
    });
});

app.get('/f/:filename', async (req, res) => {
    const db = getDB();
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM files WHERE filename = ?',
            args: [req.params.filename]
        });
        const file = result.rows[0];
        
        if (!file) {
            return res.status(404).send('File not found');
        }
        
        const fetch = await getFetch();
        let response = null;
        let usedProvider = null;
        
        if (file.primaryProvider === 'cloudsky' && file.cloudSkyUrl) {
            try {
                console.log(`🔄 Trying CloudSky (primary) for ${file.filename}`);
                response = await fetch(file.cloudSkyUrl);
                if (response.ok) {
                    usedProvider = 'cloudsky';
                    console.log(`✅ CloudSky success for ${file.filename}`);
                }
            } catch (err) {
                console.error(`❌ CloudSky failed for ${file.filename}:`, err.message);
            }
        } else if (file.primaryProvider === 'catbox' && file.catboxUrl) {
            try {
                console.log(`🔄 Trying Catbox (primary) for ${file.filename}`);
                response = await fetch(file.catboxUrl);
                if (response.ok) {
                    usedProvider = 'catbox';
                    console.log(`✅ Catbox success for ${file.filename}`);
                }
            } catch (err) {
                console.error(`❌ Catbox failed for ${file.filename}:`, err.message);
            }
        }
        
        if (!response || !response.ok) {
            console.log(`⚠️ Primary provider failed, trying backup...`);
            
            if (file.catboxUrl && usedProvider !== 'catbox') {
                try {
                    console.log(`🔄 Trying Catbox (backup) for ${file.filename}`);
                    response = await fetch(file.catboxUrl);
                    if (response.ok) {
                        usedProvider = 'catbox';
                        console.log(`✅ Catbox backup success for ${file.filename}`);
                    }
                } catch (err) {
                    console.error(`❌ Catbox backup failed for ${file.filename}:`, err.message);
                }
            }
            
            if ((!response || !response.ok) && file.cloudSkyUrl && usedProvider !== 'cloudsky') {
                try {
                    console.log(`🔄 Trying CloudSky (backup) for ${file.filename}`);
                    response = await fetch(file.cloudSkyUrl);
                    if (response.ok) {
                        usedProvider = 'cloudsky';
                        console.log(`✅ CloudSky backup success for ${file.filename}`);
                    }
                } catch (err) {
                    console.error(`❌ CloudSky backup failed for ${file.filename}:`, err.message);
                }
            }
        }
        
        if (!response || !response.ok) {
            console.error(`❌ All providers failed for ${file.filename}`);
            return res.status(502).send('Error fetching file from storage - all providers failed');
        }
        
        res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
        res.setHeader('Content-Length', file.size);
        res.setHeader('Content-Disposition', `inline; filename="${file.originalName}"`);
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-Served-By', usedProvider); // Debug header
        
        response.body.pipe(res);
        
    } catch (err) {
        console.error('Error serving file:', err);
        res.status(500).send('Internal server error');
    }
});

async function processUpload(file, req) {
    const fs = require('fs');
    const db = getDB();
    const fileExt = path.extname(file.originalname);
    
    if (file.size > 200 * 1024 * 1024) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        throw new Error('Upload limit exceeded (200MB max)');
    }

    const buffer = fs.readFileSync(file.path);
    
    let uploadResult;
    try {
        uploadResult = await uploadToMultipleProviders(buffer, file.mimetype, 'cloudku');
    } catch (err) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        throw new Error(`Upload failed: ${err.message}`);
    }
    
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

    const fileId = uuidv4();

    let fileName;
    let publicUrl;
    let success = false;
    let attempts = 0;
    const maxAttempts = 10;

    while (!success && attempts < maxAttempts) {
        fileName = `${generateRandomString(6)}${fileExt}`;
        publicUrl = `${req.protocol}://${req.get('host')}/f/${fileName}`;

        try {
            await db.execute({
                sql: 'INSERT INTO files (id, filename, originalName, size, mimetype, cloudSkyUrl, catboxUrl, primaryProvider, publicUrl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                args: [
                    fileId, 
                    fileName, 
                    file.originalname, 
                    file.size, 
                    file.mimetype, 
                    uploadResult.cloudSkyUrl,
                    uploadResult.catboxUrl,
                    uploadResult.primaryProvider,
                    publicUrl
                ]
            });
            
            success = true;
            console.log(`✅ File uploaded: ${fileName} (Primary: ${uploadResult.primaryProvider})`);
            
        } catch (err) {
            if (err.message && (err.message.includes('UNIQUE') || err.message.includes('constraint'))) {
                attempts++;
                console.warn(`⚠️ Collision detected. Retry ${attempts}/${maxAttempts}...`);
                
                if (attempts >= 5) {
                    fileName = `${generateRandomString(8)}${fileExt}`;
                }
            } else {
                throw err;
            }
        }
    }

    if (!success) {
        throw new Error('Failed to generate unique filename');
    }

    return { 
        url: publicUrl, 
        filename: fileName,
        providers: {
            cloudsky: uploadResult.cloudSkyUrl ? 'success' : 'failed',
            catbox: uploadResult.catboxUrl ? 'success' : 'failed',
            primary: uploadResult.primaryProvider
        }
    };
}

function sendUploadResponse(req, res, result, uploadedFile) {
    const acceptsJson = req.headers.accept && req.headers.accept.includes('application/json');
    
    if (acceptsJson || req.path.includes('api.php')) {
        return res.status(200).json({
            status: 'success',
            url: result.url,
            filename: result.filename,
            originalName: uploadedFile
        });
    }
    
    res.render('index', { 
        uploadedUrl: result.url, 
        uploadedFile: uploadedFile
    });
}

// Route Upload Regular (Existing)
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        const acceptsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (acceptsJson) {
            return res.status(400).json({ status: 'error', message: 'No file provided' });
        }
        return res.status(400).send('No file provided');
    }
    
    try {
        const result = await processUpload(req.file, req);
        sendUploadResponse(req, res, result, req.file.originalname);
    } catch (err) {
        console.error('Upload error:', err);
        const acceptsJson = req.headers.accept && req.headers.accept.includes('application/json');
        if (acceptsJson) {
            return res.status(500).json({ status: 'error', message: err.message });
        }
        res.status(500).send(`Error: ${err.message}`);
    }
});

// Route API PHP (Existing)
app.post('/cdn/api.php', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ status: 'error', message: 'No file provided' });
    }
    
    try {
        const result = await processUpload(req.file, req);
        res.status(200).json({
            status: 'success',
            url: result.url,
            filename: result.filename,
            originalName: req.file.originalname
        });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// --- GITHUB SERVICE ROUTES (NEW) ---

// 1. Create Repository
app.post('/repo/create', async (req, res) => {
    const { repoName, token, isPrivate } = req.body;
    const result = await githubService.createRepo(repoName, token, isPrivate);
    res.status(result.success ? 200 : 400).json(result);
});

// 2. Delete Repository
app.delete('/repo/delete', async (req, res) => {
    const { username, repoName, token } = req.body;
    const result = await githubService.deleteRepo(username, repoName, token);
    res.status(result.success ? 200 : 400).json(result);
});

// 3. Upload Zip File (Local Path/Buffer)
app.post('/upload/zip', upload.single('file'), async (req, res) => {
    const { username, repoName, token, createIfNotExists } = req.body;
    
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    // Note: req.file.path sudah menunjuk ke /tmp/uploads/ sesuai config multer di atas
    const result = await githubService.uploadZipFile(
        req.file.path, 
        username, 
        repoName, 
        token, 
        createIfNotExists === 'true'
    );
    res.status(result.success ? 200 : 400).json(result);
});

// 4. Upload Zip from URL
app.post('/upload/zip-url', async (req, res) => {
    const { url, username, repoName, token, createIfNotExists } = req.body;
    const result = await githubService.uploadZipFromUrl(url, username, repoName, token, createIfNotExists);
    res.status(result.success ? 200 : 400).json(result);
});

// 5. Upload/Update Single File
app.post('/upload/single', upload.single('file'), async (req, res) => {
    const { username, repoName, token, targetPath, message } = req.body;
    
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const result = await githubService.uploadSingleFile({
        username,
        repoName,
        token,
        filePath: req.file.path,
        targetPath,
        message
    });
    res.status(result.success ? 200 : 400).json(result);
});

// 6. Delete Single File
app.delete('/file/delete', async (req, res) => {
    const { username, repoName, token, targetPath, message } = req.body;
    const result = await githubService.deleteSingleFile({ username, repoName, token, targetPath, message });
    res.status(result.success ? 200 : 400).json(result);
});

// 7. Get Repo Info
app.get('/repo/info', async (req, res) => {
    const { username, repoName, token } = req.query; 
    const result = await githubService.getRepoInfo(username, repoName, token);
    res.status(result.success ? 200 : 400).json(result);
});

module.exports = app;
