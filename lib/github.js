const { Octokit } = require("@octokit/rest");
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const axios = require('axios');

class GithubService {
    
    getOctokit(token) {
        return new Octokit({ auth: token });
    }

    async createRepo(repoName, token, isPrivate = false) {
        const octokit = this.getOctokit(token);
        try {
            const { data } = await octokit.repos.createForAuthenticatedUser({
                name: repoName,
                description: "Uploaded via cloudku.sbs",
                private: isPrivate,
                auto_init: false 
            });
            return { success: true, data };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async deleteRepo(username, repoName, token) {
        const octokit = this.getOctokit(token);
        try {
            await octokit.repos.delete({
                owner: username,
                repo: repoName
            });
            return { success: true };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async uploadZipFile(zipFilePath, username, repoName, token, createIfNotExists = true) {
        const octokit = this.getOctokit(token);
        const targetDir = path.join(process.cwd(), `temp_upload_${Date.now()}`);

        try {
            if (!await fs.pathExists(zipFilePath)) {
                return { success: false, message: 'File zip tidak ditemukan' };
            }

            let repoExists = false;
            try {
                await octokit.repos.get({ owner: username, repo: repoName });
                repoExists = true;
            } catch (error) {
                if (error.status === 404 && createIfNotExists) {
                    const createResult = await this.createRepo(repoName, token);
                    if (!createResult.success) {
                        return { success: false, message: `Gagal membuat repository: ${createResult.message}` };
                    }
                    repoExists = true;
                } else {
                    return { success: false, message: 'Repository tidak ditemukan' };
                }
            }

            await fs.ensureDir(targetDir);
            
            console.log('Mengekstrak file zip...');
            const zip = new AdmZip(zipFilePath);
            zip.extractAllTo(targetDir, true);

            let workingDir = targetDir;
            const items = await fs.readdir(targetDir);
            
            if (items.length === 1) {
                const itemPath = path.join(targetDir, items[0]);
                const stats = await fs.stat(itemPath);
                if (stats.isDirectory()) {
                    workingDir = itemPath;
                }
            }

            const filesInDir = await this.getAllFiles(workingDir);
            if (filesInDir.length === 0) {
                throw new Error('Tidak ada file ditemukan dalam zip');
            }

            console.log(`Ditemukan ${filesInDir.length} file untuk diupload`);

            try {
                execSync('git --version', { stdio: 'ignore' });
            } catch (error) {
                return { success: false, message: 'Git tidak terinstall di sistem' };
            }

            const authUrl = `https://${username}:${token}@github.com/${username}/${repoName}.git`;
            
            const gitCmds = [
                `git init`,
                `git config user.email "${username}@github.com"`,
                `git config user.name "${username}"`,
                `git add .`,
                `git commit -m "Upload via cloudku.sbs"`,
                `git branch -M main`,
                `git remote add origin ${authUrl}`,
                `git push -u origin main --force`
            ];

            console.log('Mengupload ke GitHub...');
            for (const cmd of gitCmds) {
                try {
                    execSync(cmd, { cwd: workingDir, stdio: 'pipe' });
                } catch (error) {
                    throw new Error(`Git command failed: ${cmd} - ${error.message}`);
                }
            }

            return { 
                success: true, 
                url: `https://github.com/${username}/${repoName}`,
                filesUploaded: filesInDir.length
            };

        } catch (error) {
            console.error('Upload error:', error);
            return { success: false, message: error.message };
        } finally {
            setTimeout(async () => {
                try {
                    await fs.remove(targetDir);
                    console.log('Temporary directory cleaned up');
                } catch (err) {
                    console.error('Failed to cleanup temp directory:', err);
                }
            }, 5000);
        }
    }

    async uploadZipFromUrl(url, username, repoName, token, createIfNotExists = true) {
        const octokit = this.getOctokit(token);
        const targetDir = path.join(process.cwd(), `temp_upload_${Date.now()}`);

        try {
            let repoExists = false;
            try {
                await octokit.repos.get({ owner: username, repo: repoName });
                repoExists = true;
            } catch (error) {
                if (error.status === 404 && createIfNotExists) {
                    const createResult = await this.createRepo(repoName, token);
                    if (!createResult.success) {
                        return { success: false, message: `Gagal membuat repository: ${createResult.message}` };
                    }
                } else {
                    return { success: false, message: 'Repository tidak ditemukan' };
                }
            }

            await fs.ensureDir(targetDir);
            
            console.log('Mendownload file zip dari URL...');
            const response = await axios({ 
                url, 
                method: 'GET', 
                responseType: 'arraybuffer',
                timeout: 60000 
            });
            
            const zipPath = path.join(targetDir, 'temp.zip');
            await fs.writeFile(zipPath, response.data);

            console.log('Mengekstrak file zip...');
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(targetDir, true);
            await fs.remove(zipPath); 

            let workingDir = targetDir;
            const items = await fs.readdir(targetDir);
            if (items.length === 1) {
                const itemPath = path.join(targetDir, items[0]);
                const stats = await fs.stat(itemPath);
                if (stats.isDirectory()) {
                    workingDir = itemPath;
                }
            }

            const filesInDir = await this.getAllFiles(workingDir);
            if (filesInDir.length === 0) {
                throw new Error('Tidak ada file ditemukan dalam zip');
            }

            console.log(`Ditemukan ${filesInDir.length} file untuk diupload`);

            const authUrl = `https://${username}:${token}@github.com/${username}/${repoName}.git`;
            
            const gitCmds = [
                `git init`,
                `git config user.email "${username}@github.com"`,
                `git config user.name "${username}"`,
                `git add .`,
                `git commit -m "Upload via cloudku.sbs - ${new Date().toISOString()}"`,
                `git branch -M main`,
                `git remote add origin ${authUrl}`,
                `git push -u origin main --force`
            ];

            console.log('Mengupload ke GitHub...');
            for (const cmd of gitCmds) {
                execSync(cmd, { cwd: workingDir, stdio: 'pipe' });
            }

            return { 
                success: true, 
                url: `https://github.com/${username}/${repoName}`,
                filesUploaded: filesInDir.length
            };

        } catch (error) {
            console.error('Upload error:', error);
            return { success: false, message: error.message };
        } finally {
            setTimeout(async () => {
                try {
                    await fs.remove(targetDir);
                } catch (err) {
                    console.error('Failed to cleanup:', err);
                }
            }, 5000);
        }
    }

    async getAllFiles(dirPath, arrayOfFiles = []) {
        const files = await fs.readdir(dirPath);

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = await fs.stat(filePath);

            if (stats.isDirectory()) {
                if (file !== '.git') {
                    arrayOfFiles = await this.getAllFiles(filePath, arrayOfFiles);
                }
            } else {
                arrayOfFiles.push(filePath);
            }
        }

        return arrayOfFiles;
    }

    async uploadSingleFile({ username, repoName, token, filePath, targetPath, message }) {
        const octokit = this.getOctokit(token);
        try {
            if (!await fs.pathExists(filePath)) {
                return { success: false, message: 'File tidak ditemukan' };
            }

            const fileBuffer = await fs.readFile(filePath);
            const contentEncoded = fileBuffer.toString("base64");
            
            let sha = undefined;
            try {
                const { data } = await octokit.repos.getContent({
                    owner: username,
                    repo: repoName,
                    path: targetPath,
                });
                sha = data.sha;
            } catch (e) {
            }

            const response = await octokit.repos.createOrUpdateFileContents({
                owner: username,
                repo: repoName,
                path: targetPath,
                message: message || `Upload file ${path.basename(targetPath)} via cloudku.sbs`,
                content: contentEncoded,
                sha: sha
            });

            const branch = response.data.content.html_url.includes('/blob/main/') ? 'main' : 'master';

            return { 
                success: true, 
                url: response.data.content.html_url,
                raw_url: `https://raw.githubusercontent.com/${username}/${repoName}/${branch}/${targetPath}`
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    async deleteSingleFile({ username, repoName, token, targetPath, message }) {
        const octokit = this.getOctokit(token);
        try {
            const { data } = await octokit.repos.getContent({
                owner: username,
                repo: repoName,
                path: targetPath,
            });

            await octokit.repos.deleteFile({
                owner: username,
                repo: repoName,
                path: targetPath,
                message: message || `Delete file ${path.basename(targetPath)} via cloudku.sbs`,
                sha: data.sha,
            });

            return { success: true, message: `File ${targetPath} berhasil dihapus.` };
        } catch (error) {
            if (error.status === 404) {
                return { success: false, message: "File tidak ditemukan di repositori." };
            }
            return { success: false, message: error.message };
        }
    }

    async getRepoInfo(username, repoName, token) {
        const octokit = this.getOctokit(token);
        try {
            const { data } = await octokit.repos.get({
                owner: username,
                repo: repoName
            });
            return { success: true, data };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
}

module.exports = new GithubService();
