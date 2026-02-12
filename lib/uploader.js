const FormData = require('form-data');
const { fromBuffer } = require('file-type');
const crypto = require('crypto');

const getFetch = async () => {
    const fetchModule = await import('node-fetch');
    return fetchModule.default;
};

const uploadToCloudSky = async (buffer, mimetype = null, prefix = 'cloudku') => {
    try {
        const fetch = await getFetch();
        
        let mime = mimetype;
        let ext = 'bin';
        
        if (!mime) {
            const type = await fromBuffer(buffer);
            mime = type ? type.mime : 'application/octet-stream';
            ext = type ? type.ext : 'bin';
        } else {
            const mimeToExt = {
                // Images
                'image/jpeg': 'jpg',
                'image/png': 'png',
                'image/gif': 'gif',
                'image/webp': 'webp',
                'image/svg+xml': 'svg',
                'image/avif': 'avif',
                'image/tiff': 'tiff',
                'image/x-icon': 'ico',

                // Videos
                'video/mp4': 'mp4',
                'video/webm': 'webm',
                'video/quicktime': 'mov',
                'video/x-msvideo': 'avi',
                'video/x-matroska': 'mkv',

                // Audio
                'audio/mpeg': 'mp3',
                'audio/wav': 'wav',
                'audio/ogg': 'ogg',
                'audio/mp4': 'm4a',
                'audio/aac': 'aac',

                // Documents
                'application/pdf': 'pdf',
                'text/plain': 'txt',
                'text/html': 'html',
                'text/csv': 'csv',
                'application/json': 'json',
                'application/msword': 'doc',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                'application/vnd.ms-excel': 'xls',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
                'application/vnd.ms-powerpoint': 'ppt',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',

                // Archives
                'application/zip': 'zip',
                'application/x-7z-compressed': '7z',
                'application/x-rar-compressed': 'rar',
                'application/x-tar': 'tar',
            };
            ext = mimeToExt[mime] || mime.split('/')[1] || 'bin';
        }
        
        const fileKey = `${prefix}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
        const fileSize = buffer.length;

        const presignResponse = await fetch('https://api.cloudsky.biz.id/get-upload-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileKey: fileKey,
                contentType: mime,
                fileSize: fileSize
            })
        });

        if (!presignResponse.ok) {
            const errorText = await presignResponse.text();
            throw new Error(`Failed to get presigned URL: ${errorText}`);
        }
        
        const { uploadUrl } = await presignResponse.json();
        if (!uploadUrl) {
            throw new Error('No uploadUrl received from API');
        }

        const uploadResponse = await fetch(uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': mime,
                'x-amz-server-side-encryption': 'AES256'
            },
            body: buffer
        });
        
        if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            throw new Error(`File upload failed: ${errorText}`);
        }

        return `https://api.cloudsky.biz.id/file?key=${fileKey}`;

    } catch (error) {
        console.error('CloudSky Upload Error:', error.message);
        throw new Error(`CloudSky upload failed: ${error.message}`);
    }
};

const uploadToCatbox = async (buffer) => {
    try {
        const fetch = await getFetch();
        const type = await fromBuffer(buffer);
        const ext = type ? type.ext : 'bin';
        const bodyForm = new FormData();
        bodyForm.append("fileToUpload", buffer, `file.${ext}`);
        bodyForm.append("reqtype", "fileupload");

        const res = await fetch("https://catbox.moe/user/api.php", {
            method: "POST",
            body: bodyForm,
            headers: bodyForm.getHeaders()
        });
        
        const url = await res.text();
        
        if (!url || !url.startsWith('http')) {
            throw new Error('Invalid response from Catbox');
        }
        
        return url.trim();
    } catch (error) {
        console.error("Catbox Upload Error:", error.message);
        throw new Error(`Catbox upload failed: ${error.message}`);
    }
};

const uploadToMultipleProviders = async (buffer, mimetype = null, prefix = 'cloudku') => {
    console.log('📤 Starting dual upload to CloudSky and Catbox...');
    
    const [cloudSkyResult, catboxResult] = await Promise.allSettled([
        uploadToCloudSky(buffer, mimetype, prefix),
        uploadToCatbox(buffer)
    ]);
    
    const result = {
        cloudSkyUrl: null,
        catboxUrl: null,
        primaryProvider: null,
        backupProvider: null
    };
    
    if (cloudSkyResult.status === 'fulfilled') {
        result.cloudSkyUrl = cloudSkyResult.value;
        console.log('✅ CloudSky upload success');
    } else {
        console.error('❌ CloudSky upload failed:', cloudSkyResult.reason.message);
    }
    
    if (catboxResult.status === 'fulfilled') {
        result.catboxUrl = catboxResult.value;
        console.log('✅ Catbox upload success');
    } else {
        console.error('❌ Catbox upload failed:', catboxResult.reason.message);
    }
    
    if (result.cloudSkyUrl && result.catboxUrl) {
        result.primaryProvider = 'cloudsky';
        result.backupProvider = 'catbox';
        console.log('✅ Both providers success - CloudSky as primary');
    } else if (result.cloudSkyUrl) {
        result.primaryProvider = 'cloudsky';
        console.log('⚠️ Only CloudSky success');
    } else if (result.catboxUrl) {
        result.primaryProvider = 'catbox';
        console.log('⚠️ Only Catbox success');
    } else {
        throw new Error('Both CloudSky and Catbox upload failed');
    }
    
    return result;
};

module.exports = { 
    uploadToCloudSky,
    uploadToCatbox,
    uploadToMultipleProviders
};