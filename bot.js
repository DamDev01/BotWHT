const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const axios = require('axios');
const { traduzirPDF } = require('./pdf_translate');
const FormData = require('form-data');
const fsExtra = require('fs-extra');
const { spawn } = require('child_process');
const cheerio = require('cheerio');

// Configurações
const GROUP_ID = "120363324835732918@g.us";
const DB_FILE = path.join(__dirname, 'membros_grupo.json');
let membrosGrupo = {};
const TELEGRAM_BOT_TOKEN = '7848885574:AAHgJ5E-KyXCv2i_O_hABDv6CTBqnwugmqk';
const TELEGRAM_GROUP_ID = '-1002304854743';
const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN);
const INSTAGRAM_URL = 'https://www.instagram.com/davidnutrifacil/';
let lastPostUrl = null;

// Carregar banco de dados
try {
    if (fs.existsSync(DB_FILE)) {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        membrosGrupo = JSON.parse(data);
        console.log(`✅ Banco de dados carregado: ${Object.keys(membrosGrupo[GROUP_ID] || {}).length} membros`);
    } else {
        membrosGrupo[GROUP_ID] = {};
        fs.writeFileSync(DB_FILE, JSON.stringify(membrosGrupo, null, 2));
        console.log('✅ Banco de dados criado');
    }
} catch (error) {
    console.error('❌ Erro ao carregar banco de dados:', error);
    membrosGrupo[GROUP_ID] = {};
}

// Funções auxiliares
function salvarMembro(groupId, id, nome = '') {
    if (!id || typeof id !== 'string') return;
    if (!membrosGrupo[groupId]) membrosGrupo[groupId] = {};
    membrosGrupo[groupId][id] = { nome: nome || '', ultimaVisto: new Date().toISOString() };
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(membrosGrupo, null, 2));
    } catch (error) {
        console.error('❌ Erro ao salvar banco de dados:', error);
    }
}

function extrairAuthor(msg) {
    if (!msg) return null;
    try {
        return msg.author || msg._data?.author || (msg.from.includes('@c.us') ? msg.from : null);
    } catch (error) {
        console.error('⚠️ Erro ao extrair author:', error.message);
        return null;
    }
}

function extrairMensagemPersonalizada(texto) {
    let mensagem = texto.replace(/^!mencionar\s*/i, '').trim();
    return mensagem || "🚨 *ATENÇÃO TODOS DO GRUPO!* 🚨\nSua atenção é solicitada!";
}

function truncarMensagem(mensagem, maxLength = 75) {
    if (!mensagem) return "";
    mensagem = mensagem.replace(/\n/g, ' ');
    return mensagem.length > maxLength ? mensagem.substring(0, maxLength) + "..." : mensagem;
}

function formatarData(data) {
    return data ? data.toLocaleString() : "Data desconhecida";
}

function validarDOI(doi) {
    return /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(doi);
}

async function buscarVersaoAberta(doi) {
    try {
        const unpaywallResponse = await axios.get(`https://api.unpaywall.org/v2/${doi}`, {
            params: { email: 'damdev0101@gmail.com' }
        });
        if (unpaywallResponse.data.best_oa_location?.url) return unpaywallResponse.data.best_oa_location.url;

        const crossrefResponse = await axios.get(`https://api.crossref.org/works/${doi}`);
        if (crossrefResponse.data.message?.link) {
            for (const link of crossrefResponse.data.message.link) {
                if (link['content-type'] === 'application/pdf') return link.URL;
            }
        }
        return null;
    } catch (error) {
        console.error("❌ Erro ao buscar versão aberta:", error.message);
        return null;
    }
}

async function baixarPDF(url) {
    try {
        console.log(`🔄 Tentando baixar PDF de: ${url}`);
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            maxRedirects: 10, // Aumentado para lidar com redirecionamentos
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
                'Accept': 'application/pdf,*/*'
            }
        });

        const contentType = response.headers['content-type'];
        if (!contentType?.includes('pdf')) throw new Error(`Conteúdo não é PDF (${contentType})`);

        const fileName = `artigo_${Date.now()}.pdf`;
        fs.writeFileSync(fileName, response.data);
        console.log(`✅ PDF baixado: ${fileName}`);
        return fileName;
    } catch (error) {
        console.error("❌ Erro ao baixar PDF:", error.message);
        throw error;
    }
}

async function pesquisarArtigoNaWeb(termo) {
    console.log(`🔍 Pesquisando na web: "${termo}"`);
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    try {
        await page.goto(`https://scholar.google.com/scholar?q=${encodeURIComponent(termo)}`, { waitUntil: 'networkidle2' });
        const resultados = await page.evaluate(() => {
            const links = [];
            document.querySelectorAll('h3 a').forEach(link => {
                const href = link.href;
                if (href.includes('doi.org') || href.endsWith('.pdf')) links.push(href);
            });
            return links[0] || null;
        });

        await browser.close();
        if (resultados) {
            if (resultados.includes('doi.org')) {
                const doi = resultados.match(/10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/)?.[0];
                return doi ? { type: 'doi', value: doi } : null;
            }
            return { type: 'pdf', value: resultados };
        }
        return null;
    } catch (error) {
        console.error('❌ Erro ao pesquisar na web:', error.message);
        await browser.close();
        return null;
    }
}

async function downloadFromLibGen(doi) {
    const domains = ['https://libgen.is', 'https://libgen.rs', 'https://libgen.li'];
    for (const domain of domains) {
        try {
            console.log(`📚 Tentando via Library Genesis (${domain})...`);
            const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
            const page = await browser.newPage();
            await page.goto(`${domain}/scimag/?q=${encodeURIComponent(doi)}`, { waitUntil: 'networkidle2', timeout: 30000 });

            const pdfLink = await page.evaluate(() => {
                const selectors = ['a[href*=".pdf"]', 'a[title="Download"]', 'td a[href]'];
                for (const selector of selectors) {
                    const link = document.querySelector(selector);
                    if (link && link.href.includes('.pdf')) return link.href;
                }
                return null;
            });

            if (pdfLink) {
                console.log(`🔗 PDF encontrado no LibGen: ${pdfLink}`);
                const fileName = await baixarPDF(pdfLink);
                await browser.close();
                return fileName;
            }

            console.log(`❌ Nenhum PDF encontrado em ${domain}.`);
            await browser.close();
        } catch (error) {
            console.error(`❌ Erro ao buscar no LibGen (${domain}):`, error.message);
        }
    }
    return null;
}

async function downloadFromSciHub(doi) {
    const domains = ['https://sci-hub.se', 'https://sci-hub.ru', 'https://sci-hub.st', 'https://sci-hub.wf', 'http://sci-hub.ee'];
    const maxRetries = 3;

    for (const domain of domains) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🔒 Tentando ${domain} (Tentativa ${attempt}/${maxRetries})...`);
                const browser = await puppeteer.launch({ 
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox'] // Adicione '--proxy-server=socks5://127.0.0.1:9050' se usar Tor
                });
                const page = await browser.newPage();
                await page.goto(`${domain}/${doi}`, { waitUntil: 'networkidle2', timeout: 30000 });

                let pdfUrl = await page.evaluate(() => {
                    const selectors = ['iframe#pdf', 'embed[type="application/pdf"]', 'a[href*=".pdf"]'];
                    for (const selector of selectors) {
                        const element = document.querySelector(selector);
                        if (element) return element.src || element.href;
                    }
                    return null;
                });

                if (pdfUrl) {
                    if (!pdfUrl.startsWith('http')) pdfUrl = new URL(pdfUrl, domain).href;
                    const fileName = await baixarPDF(pdfUrl);
                    await browser.close();
                    return fileName;
                }

                await browser.close();
                if (attempt < maxRetries) await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                console.error(`❌ Erro em ${domain} (Tentativa ${attempt}):`, error.message);
            }
        }
    }
    return null;
}

async function downloadFromWayback(doi) {
    try {
        console.log('🕰️ Tentando via Wayback Machine...');
        const doiUrl = `https://doi.org/${doi}`;
        const waybackUrl = `http://web.archive.org/web/*/${doiUrl}`;
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(waybackUrl, { waitUntil: 'networkidle2' });

        const snapshotLink = await page.evaluate(() => {
            const links = document.querySelectorAll('a[href*="web.archive.org/web"]');
            return links.length > 0 ? links[0].href : null;
        });

        if (snapshotLink) {
            await page.goto(snapshotLink, { waitUntil: 'networkidle2' });
            const pdfLink = await page.evaluate(() => {
                const link = document.querySelector('a[href*=".pdf"]');
                return link ? link.href : null;
            });
            if (pdfLink) {
                const fileName = await baixarPDF(pdfLink);
                await browser.close();
                return fileName;
            }
        }

        await browser.close();
        return null;
    } catch (error) {
        console.error('❌ Erro ao buscar no Wayback Machine:', error.message);
        return null;
    }
}

async function downloadArtigo(doi) {
    try {
        if (!validarDOI(doi)) throw new Error('Formato DOI inválido. Exemplo: 10.1234/abc123');

        console.log(`🔍 Buscando artigo com DOI: ${doi}`);

        const sources = [
            async () => {
                console.log("🔒 Tentando via Unpaywall...");
                const url = await buscarVersaoAberta(doi);
                return url ? await baixarPDF(url) : null;
            },
            async () => {
                console.log("🌐 Tentando via ResearchGate...");
                const browser = await puppeteer.launch({ headless: true });
                const page = await browser.newPage();
                await page.goto(`https://www.researchgate.net/search/publication?q=${doi}`, { waitUntil: 'networkidle2' });
                const pdfLink = await page.evaluate(() => {
                    const links = document.querySelectorAll('a');
                    for (let link of links) {
                        if (link.href.includes('/publication/') && link.href.includes('/full')) return link.href;
                    }
                    return null;
                });
                await browser.close();
                return pdfLink ? await baixarPDF(pdfLink) : null;
            },
            async () => {
                console.log("🏥 Tentando via PubMed Central...");
                const browser = await puppeteer.launch({ headless: true });
                const page = await browser.newPage();
                const urls = [`https://www.ncbi.nlm.nih.gov/pmc/articles/${doi}/`, `https://pubmed.ncbi.nlm.nih.gov/?term=${doi}`];
                for (const url of urls) {
                    await page.goto(url, { waitUntil: 'networkidle2' });
                    const pdfLink = await page.evaluate(() => {
                        const link = document.querySelector('a[href$=".pdf"]') || document.querySelector('a.link-pdf');
                        return link ? link.href : null;
                    });
                    if (pdfLink) {
                        await browser.close();
                        return await baixarPDF(pdfLink);
                    }
                }
                await browser.close();
                return null;
            },
            async () => {
                console.log("📚 Tentando via DOAJ...");
                const browser = await puppeteer.launch({ headless: true });
                const page = await browser.newPage();
                await page.goto(`https://doaj.org/search/?source=%7B%22query%22%3A%7B%22multi_match%22%3A%7B%22query%22%3A%22${doi}%22%2C%22fields%22%3A%5B%22doi%22%5D%7D%7D%7D`, { waitUntil: 'networkidle2' });
                const pdfLink = await page.evaluate(() => {
                    const link = document.querySelector('a[href*=".pdf"]');
                    return link ? link.href : null;
                });
                await browser.close();
                return pdfLink ? await baixarPDF(pdfLink) : null;
            },
            async () => {
                console.log("🌍 Tentando via PLOS ONE...");
                const browser = await puppeteer.launch({ headless: true });
                const page = await browser.newPage();
                await page.goto(`https://journals.plos.org/plosone/article?id=${doi}`, { waitUntil: 'networkidle2' });
                const pdfLink = await page.evaluate(() => {
                    const link = document.querySelector('a[href*=".pdf"]');
                    return link ? link.href : null;
                });
                await browser.close();
                return pdfLink ? await baixarPDF(pdfLink) : null;
            },
            async () => await downloadFromLibGen(doi),
            async () => await downloadFromWayback(doi),
            async () => await downloadFromSciHub(doi)
        ];

        for (const source of sources) {
            try {
                const result = await source();
                if (result) return result;
            } catch (error) {
                console.log(`⚠️ Fonte falhou: ${error.message}`);
            }
        }

        throw new Error('Nenhuma fonte conseguiu encontrar o artigo');
    } catch (error) {
        console.error("❌ Erro no download:", error.message);
        throw error;
    }
}

async function resumirConversas(groupId, limit = 100) {
    try {
        const chat = await client.getChatById(groupId);
        const messages = await chat.fetchMessages({ limit });
        const mensagensRelevantes = messages
            .filter(msg => !msg.fromMe && !msg.body.startsWith('!') && msg.body.length > 20)
            .map(msg => msg.body);

        const resumo = mensagensRelevantes.join(' ');
        return `📝 *RESUMO DAS ÚLTIMAS ${limit} MENSAGENS:*\n\n${resumo}`;
    } catch (error) {
        console.error("❌ Erro ao gerar resumo:", error);
        return `❌ Erro ao gerar resumo: ${error.message}`;
    }
}

async function enviarLinkTelegram(chatId) {
    try {
        await client.sendMessage(chatId, `📚 *PRECISA DE MATERIAL?*
Entre no Telegram:
🔗 https://t.me/+2IOMWchS3dk5N2Jh`);
    } catch (error) {
        console.error('❌ Erro ao enviar link do Telegram:', error.message);
    }
}

async function enviarLinkGrupo(chatId) {
    await client.sendMessage(chatId, `🔗 *COMPARTILHE O GRUPO!*\nhttps://chat.whatsapp.com/HypAx9g51w06SWU8nrbwkc`);
}

async function enviarAoTelegram(mensagem) {
    try {
        await telegramBot.sendMessage(TELEGRAM_GROUP_ID, mensagem);
        console.log("✅ Mensagem enviada ao Telegram!");
    } catch (error) {
        console.error("❌ Erro ao enviar ao Telegram:", error.message);
    }
}

async function encaminharPedidoAoTelegram(chatId, pedido, nomeUsuario) {
    const mensagem = `📚 *Novo pedido no WhatsApp:*
👤 *Usuário:* ${nomeUsuario}
📝 *Pedido:* ${pedido}
🔗 https://t.me/+2IOMWchS3dk5N2Jh`;
    try {
        await enviarAoTelegram(mensagem);
    } catch (error) {
        console.error('❌ Erro ao encaminhar pedido ao Telegram:', error.message);
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions'
        ],
        executablePath: '/usr/bin/chromium'
    }
});

client.on('qr', (qr) => {
    console.log('📱 Escaneie o QR Code:');
    qrcode.generate(qr, { small: true });
});

async function checkForNewPosts() {
    console.log('🔍 Verificando Instagram...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.goto(INSTAGRAM_URL, { waitUntil: 'networkidle2' });
        await page.waitForSelector('a[href*="/p/"]', { timeout: 20000 });
        const firstPost = await page.evaluate(() => {
            const posts = document.querySelectorAll('a[href*="/p/"]');
            return posts.length > 0 ? posts[0].href : null;
        });
        if (firstPost && firstPost !== lastPostUrl) {
            lastPostUrl = firstPost;
            await client.sendMessage(GROUP_ID, `Hey Nutri's ❤️ Novo post no Instagram!\n${firstPost}`);
            console.log(`✅ Notificação enviada: ${firstPost}`);
        }
    } catch (error) {
        console.error('❌ Erro ao verificar Instagram:', error.message);
    } finally {
        await browser.close();
    }
}

client.on('ready', async () => {
    console.log('✅ Bot conectado!');
    await client.sendMessage(GROUP_ID, `🤖 *Bot Ativo* 🤖
Comandos:

!mencionar [msg] - Menciona todos
!resumo [qtd] - Resumo das conversas
!membros - Total de membros
!ajuda - Esta mensagem
!braia - Link do Telegram
!grupo - Link do grupo
!artigo [DOI/título] - Baixa artigo
!bot [pedido] - Encaminha ao Telegram
!traduzir - Traduzir PDF
!livro [título] - Busca livros
!upload - Faz upload de um arquivo
!nexus [tipo] [termo] - Busca em bibliotecas científicas (tipo: artigo/livro)`);

    // Enviar newsletter ao iniciar
    console.log('📰 Enviando newsletter inicial...');
    enviarNewsletterNutricao();
});

cron.schedule('0 15 * * *', () => {
    console.log('⏰ Verificação às 15:00...');
    checkForNewPosts();
});

client.on('message', async (message) => {
    if (message.fromMe) return;
    try {
        console.log(`📥 Mensagem: "${message.body}" de ${message.from}`);
        if (message.from === GROUP_ID) {
            const authorId = extrairAuthor(message);
            if (authorId) salvarMembro(GROUP_ID, authorId);

            const messageText = message.body.toLowerCase();

            if (messageText.startsWith("!artigo")) {
                const pesquisa = message.body.replace(/^!artigo\s*/i, '').trim();
                if (!pesquisa) {
                    await client.sendMessage(GROUP_ID, `⚠️ @${message.author.split('@')[0]}, forneça DOI ou título.`, { mentions: [message.author] });
                    return;
                }
                let arquivo;
                try {
                    await client.sendMessage(GROUP_ID, `🔍 @${message.author.split('@')[0]} buscando "${pesquisa}"...`, { mentions: [message.author] });
                    if (validarDOI(pesquisa)) {
                        arquivo = await downloadArtigo(pesquisa);
                    } else {
                        const resultado = await pesquisarArtigoNaWeb(pesquisa);
                        if (resultado) {
                            arquivo = resultado.type === 'doi' ? await downloadArtigo(resultado.value) : await baixarPDF(resultado.value);
                        } else {
                            throw new Error('Artigo não encontrado na pesquisa.');
                        }
                    }
                    const media = MessageMedia.fromFilePath(arquivo);
                    await client.sendMessage(message.author, media, { caption: `📄 Artigo: ${pesquisa}` });
                    await client.sendMessage(GROUP_ID, `✅ @${message.author.split('@')[0]}, enviei no privado!`, { mentions: [message.author] });
                    fs.unlinkSync(arquivo);
                } catch (error) {
                    await client.sendMessage(GROUP_ID, `❌ @${message.author.split('@')[0]}, falha: ${error.message}`, { mentions: [message.author] });
                }
            }

            else if (messageText.startsWith("!mencionar")) {
                const mensagemPersonalizada = extrairMensagemPersonalizada(message.body);
                let mencoes = [];
                let texto = mensagemPersonalizada + "\n\n";
                for (const memberId in membrosGrupo[GROUP_ID]) {
                    if (memberId.includes('@c.us')) {
                        mencoes.push(memberId);
                        texto += `@${memberId.split('@')[0]} `;
                    }
                }
                await client.sendMessage(GROUP_ID, texto, { mentions: mencoes });
            }

            else if (messageText.startsWith("!resumo")) {
                let limit = 100;
                const match = message.body.match(/!resumo\s+(\d+)/i);
                if (match && match[1]) limit = Math.min(Math.max(parseInt(match[1]), 10), 200);
                await client.sendMessage(GROUP_ID, `🔍 Gerando resumo de ${limit} mensagens...`);
                const resumo = await resumirConversas(GROUP_ID, limit);
                await client.sendMessage(GROUP_ID, resumo);
            }

            else if (messageText === "!membros") {
                const totalMembros = Object.keys(membrosGrupo[GROUP_ID] || {}).length;
                await client.sendMessage(GROUP_ID, `👥 *Membros:* ${totalMembros}`);
            }

            else if (messageText.startsWith("!upload")) {
                await client.sendMessage(GROUP_ID, `@${message.author.split('@')[0]}, por favor envie o arquivo que deseja fazer upload.`, { mentions: [message.author] });
                
                const filter = (msg) => msg.hasMedia && msg.author === message.author;
                const chat = await client.getChatById(GROUP_ID);
                let recebido = false;
                
                const onMedia = async (mediaMsg) => {
                    if (recebido || mediaMsg.author !== message.author) return;
                    recebido = true;
                    client.removeListener('message', onMedia);
                    
                    try {
                        const media = await mediaMsg.downloadMedia();
                        const buffer = Buffer.from(media.data, 'base64');
                        const tempFile = `temp_${Date.now()}_${media.filename || 'file'}`;
                        fs.writeFileSync(tempFile, buffer);
                        
                        await client.sendMessage(GROUP_ID, `⏳ Fazendo upload do arquivo, aguarde...`);
                        const result = await uploadFile(tempFile);
                        
                        if (result.success) {
                            await client.sendMessage(GROUP_ID, `✅ Upload concluído!\n🔗 Link: ${result.url}`);
                        } else {
                            throw new Error('Falha no upload');
                        }
                        
                        fs.unlinkSync(tempFile);
                    } catch (err) {
                        await client.sendMessage(GROUP_ID, `❌ Erro no upload: ${err.message}`);
                    }
                };
                
                client.on('message', onMedia);
            }

            else if (messageText.startsWith("!nexus")) {
                const args = message.body.split(' ');
                if (args.length < 3) {
                    await client.sendMessage(GROUP_ID, `⚠️ Uso correto: !nexus [tipo] [termo]\nTipos: artigo, livro\nExemplo: !nexus artigo diabetes`);
                    return;
                }

                const type = args[1].toLowerCase();
                const query = args.slice(2).join(' ');

                if (type !== 'artigo' && type !== 'livro') {
                    await client.sendMessage(GROUP_ID, `⚠️ Tipo inválido. Use 'artigo' ou 'livro'.`);
                    return;
                }

                try {
                    await client.sendMessage(GROUP_ID, `🔍 Buscando por "${query}"...`);
                    const searchType = type === 'artigo' ? 'scientific' : 'books';
                    const results = await searchNexus(query, searchType);

                    if (results && results.length > 0) {
                        let message = `📚 *Resultados para "${query}":*\n\n`;
                        results.forEach((item, index) => {
                            message += `${index + 1}. *${item.title}*\n🔗 ${item.url}\n\n`;
                        });
                        await client.sendMessage(GROUP_ID, message);
                    } else {
                        await client.sendMessage(GROUP_ID, `❌ Nenhum resultado encontrado para "${query}".`);
                    }
                } catch (error) {
                    console.error('❌ Erro na busca:', error);
                    await client.sendMessage(GROUP_ID, `❌ Erro ao buscar: ${error.message}`);
                }
            }

            else if (messageText === "!ajuda") {
                await client.sendMessage(GROUP_ID, `🤖 *Bot Ativo* 🤖
Comandos:

!mencionar [msg] - Menciona todos
!resumo [qtd] - Resumo das conversas
!membros - Total de membros
!ajuda - Esta mensagem
!braia - Link do Telegram
!grupo - Link do grupo
!artigo [DOI/título] - Baixa artigo
!bot [pedido] - Encaminha ao Telegram
!traduzir - Traduzir PDF
!livro [título] - Busca livros
!upload - Faz upload de um arquivo
!nexus [tipo] [termo] - Busca em bibliotecas científicas (tipo: artigo/livro)`);
            }

            else if (messageText === "!braia") {
                await enviarLinkTelegram(GROUP_ID);
            }

            else if (messageText === "!grupo") {
                await enviarLinkGrupo(GROUP_ID);
            }

            else if (messageText.startsWith("!bot")) {
                const pedido = message.body.replace(/^!bot\s*/i, '').trim();
                if (!pedido) {
                    await client.sendMessage(GROUP_ID, "⚠️ Inclua seu pedido após !bot.");
                    return;
                }
                const contact = await client.getContactById(authorId);
                const nomeUsuario = contact.pushname || contact.name || authorId.split('@')[0];
                await encaminharPedidoAoTelegram(GROUP_ID, pedido, nomeUsuario);
                await client.sendMessage(GROUP_ID, `✅ Pedido enviado ao Telegram: "${pedido}"`);
            }

            else if (messageText.startsWith("!traduzir")) {
                await client.sendMessage(GROUP_ID, `@${message.author.split('@')[0]}, por favor envie o arquivo PDF que deseja traduzir como documento nesta conversa do grupo.`, { mentions: [message.author] });
                // Espera pela próxima mensagem de mídia do mesmo usuário
                const filter = (msg) => msg.hasMedia && msg.author === message.author && msg.type === 'document' && msg.filename.endsWith('.pdf');
                const chat = await client.getChatById(GROUP_ID);
                let recebido = false;
                const onMedia = async (mediaMsg) => {
                    if (recebido) return;
                    recebido = true;
                    client.removeListener('message', onMedia);
                    try {
                        const media = await mediaMsg.downloadMedia();
                        const buffer = Buffer.from(media.data, 'base64');
                        const tempFile = `temp_${Date.now()}.pdf`;
                        fs.writeFileSync(tempFile, buffer);
                        await client.sendMessage(GROUP_ID, `⏳ Traduzindo o arquivo, aguarde...`);
                        const traducao = await traduzirPDF(tempFile);
                        const txtFile = tempFile.replace('.pdf', '_traduzido.txt');
                        fs.writeFileSync(txtFile, traducao);
                        await client.sendMessage(mediaMsg.author, MessageMedia.fromFilePath(txtFile), { caption: '📄 Aqui está seu PDF traduzido para português!' });
                        await client.sendMessage(GROUP_ID, `✅ @${mediaMsg.author.split('@')[0]}, seu arquivo foi traduzido e enviado no privado!`, { mentions: [mediaMsg.author] });
                        fs.unlinkSync(tempFile);
                        fs.unlinkSync(txtFile);
                    } catch (err) {
                        await client.sendMessage(GROUP_ID, `❌ Erro ao traduzir: ${err.message}`);
                    }
                };
                client.on('message', onMedia);
            }

            else if (messageText.startsWith("!livro")) {
                const titulo = message.body.replace('!livro', '').trim();
                if (!titulo) {
                    await client.sendMessage(message.from, '⚠️ Por favor, forneça o título do livro após o comando !livro.');
                    return;
                }

                try {
                    await client.sendMessage(message.from, `🔍 Buscando o livro "${titulo}"...`);
                    const fileName = await buscarLivroNaWeb(titulo);
                    const media = MessageMedia.fromFilePath(fileName);
                    await client.sendMessage(message.from, media, { caption: `📚 Aqui está o livro "${titulo}".` });
                    fs.unlinkSync(fileName); // Remove o arquivo após o envio
                } catch (error) {
                    await client.sendMessage(message.from, `❌ Não foi possível encontrar o livro "${titulo}": ${error.message}`);
                }
            }
        }
    } catch (error) {
        console.error("❌ Erro ao processar mensagem:", error.message);
    }
});

client.on('group_join', async (notification) => {
    if (notification.chatId === GROUP_ID) {
        salvarMembro(GROUP_ID, notification.id.participant);
        const user = notification.id.participant.split('@')[0];
        const welcomeMsg = `👋 *Bem-vindo(a) @${user}!*\nDigite *!ajuda* para comandos.\n⚠️ Regras:\n✅ Siga https://www.instagram.com/davidnutrifacil/\n✅ Coloque seu Instagram\n✅ Se apresente\n✅ Respeite todos\n✅ Sem spam\n✅ Sem conteúdo protegido\n✅ Mantenha o tema\n\n ✅Material no Telegram!`;
        await client.sendMessage(GROUP_ID, welcomeMsg, { mentions: [notification.id.participant] });
    }
});

client.on('group_leave', async (notification) => {
    if (notification.chatId === GROUP_ID && membrosGrupo[GROUP_ID]?.[notification.id.participant]) {
        delete membrosGrupo[GROUP_ID][notification.id.participant];
        fs.writeFileSync(DB_FILE, JSON.stringify(membrosGrupo, null, 2));
    }
});

client.on('auth_failure', (error) => console.error('❌ Erro de autenticação:', error));

client.on('disconnected', async (reason) => {
    console.log('🔌 Desconectado:', reason);
    await gracefulShutdown(client, 'DISCONNECTED', reason);
});

async function gracefulShutdown(client, signal = 'UNKNOWN', reason = '') {
    console.log(`🛑 Encerrando (Sinal: ${signal})...`);
    for (let i = 5; i > 0; i--) {
        console.log(`⏳ Encerrando em ${i}s...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await client.sendMessage(GROUP_ID, `⚠️ *Bot desligado.*\nMotivo: ${reason}\nHorário: ${new Date().toLocaleString()}`);
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown(client, 'SIGTERM'));
process.on('SIGINT', () => gracefulShutdown(client, 'SIGINT'));

process.on('uncaughtException', async (error) => {
    console.error('❌ Erro não tratado:', error);
    try {
        if (client.pupPage && client.info) {
            await client.sendMessage(GROUP_ID, `❌ *ERRO CRÍTICO:* ${error.message}`);
        }
    } catch (sendError) {
        console.error('Não foi possível enviar mensagem de erro:', sendError);
    }
    process.exit(1);
});

process.on('unhandledRejection', async (error) => {
    console.error('❌ Rejeição não tratada:', error);
    try {
        if (client.pupPage && client.info) {
            await client.sendMessage(GROUP_ID, `❌ *ERRO CRÍTICO:* ${error.message}`);
        }
    } catch (sendError) {
        console.error('Não foi possível enviar mensagem de erro:', sendError);
    }
    process.exit(1);
});

console.log('🚀 Iniciando o bot...');
client.initialize();

setInterval(() => {
    const memTotal = Object.keys(membrosGrupo[GROUP_ID] || {}).length;
    console.log(`🕒 Bot rodando - ${new Date().toLocaleString()} - ${memTotal} membros`);
}, 3600000);

async function buscarLivroNaWeb(titulo) {
    console.log(`🔍 Pesquisando livro: "${titulo}"`);
    const domains = [
        'https://libgen.is',
        'https://libgen.rs',
        'https://libgen.li',
        'https://zlibrary.to',
        'https://openlibrary.org',
        'https://sci-hub.se',
        'https://annas-archive.org',
        'https://pdfdrive.com',
        'https://ebookhunter.ch'
    ];

    for (const domain of domains) {
        try {
            const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
            const page = await browser.newPage();
            await page.goto(`${domain}/search.php?req=${encodeURIComponent(titulo)}&open=0&res=25&view=simple&phrase=1&column=def`, { waitUntil: 'networkidle2' });

            const link = await page.evaluate(() => {
                const result = document.querySelector('table a[href*="book"]');
                return result ? result.href : null;
            });

            if (link) {
                await page.goto(link, { waitUntil: 'networkidle2' });
                const downloadLink = await page.evaluate(() => {
                    const link = document.querySelector('a[href*=".pdf"]');
                    return link ? link.href : null;
                });

                if (downloadLink && downloadLink.startsWith('http')) {
                    console.log(`📚 Link de download encontrado: ${downloadLink}`);
                    const response = await axios.get(downloadLink, { responseType: 'arraybuffer' });
                    const fileName = `livro_${Date.now()}.pdf`;
                    fs.writeFileSync(fileName, response.data);
                    await browser.close();
                    return fileName;
                } else {
                    console.log(`⚠️ Nenhum link válido encontrado em ${domain}.`);
                }
            }

            await browser.close();
        } catch (error) {
            console.error(`❌ Erro ao buscar livro em ${domain}:`, error.message);
        }
    }

    // Pesquisa na web como alternativa
    try {
        console.log('🌐 Ampliando busca na web...');
        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(titulo + ' filetype:pdf')}`, { waitUntil: 'networkidle2' });

        const webLink = await page.evaluate(() => {
            const result = document.querySelector('a[href*=".pdf"]');
            return result ? result.href : null;
        });

        if (webLink && webLink.startsWith('http')) {
            console.log(`🌐 Link encontrado na web: ${webLink}`);
            const response = await axios.get(webLink, { responseType: 'arraybuffer' });
            const fileName = `livro_web_${Date.now()}.pdf`;
            fs.writeFileSync(fileName, response.data);
            await browser.close();
            return fileName;
        } else {
            console.log('⚠️ Nenhum link válido encontrado na web.');
        }

        await browser.close();
    } catch (error) {
        console.error('❌ Erro ao buscar na web:', error.message);
    }

    throw new Error('Livro não encontrado em nenhuma fonte ou na web.');
}

async function uploadFile(filePath) {
    try {
        const form = new FormData();
        form.append('file', fsExtra.createReadStream(filePath));
        
        const response = await axios.post('https://api.anonfiles.com/upload', form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity
        });

        if (response.data.status) {
            return {
                success: true,
                url: response.data.data.file.url.full
            };
        } else {
            throw new Error(response.data.error.message || 'Erro no upload');
        }
    } catch (error) {
        console.error('❌ Erro no upload:', error.message);
        throw error;
    }
}

async function searchNexus(query, type = 'scientific') {
    return new Promise((resolve, reject) => {
        const python = spawn('python', ['nexus_search.py', query, type]);
        let data = '';

        python.stdout.on('data', (chunk) => {
            data += chunk;
        });

        python.stderr.on('data', (data) => {
            console.error(`🐍 Erro Python: ${data}`);
        });

        python.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Processo Python encerrou com código ${code}`));
                return;
            }
            try {
                const results = JSON.parse(data);
                resolve(results);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function buscarNoticiasNutricao() {
    try {
        // Fontes RSS confiáveis de nutrição (Google News em português e inglês)
        const urls = [
            'https://news.google.com/rss/search?q=nutri%C3%A7%C3%A3o+OR+alimenta%C3%A7%C3%A3o+saud%C3%A1vel+OR+dieta&hl=pt-BR&gl=BR&ceid=BR:pt-419',
            'https://news.google.com/rss/search?q=nutrition+OR+healthy+diet+OR+food+science&hl=en-US&gl=US&ceid=US:en',
            'https://www.sciencedaily.com/rss/health_medicine/nutrition.xml'
        ];        let noticias = [];
        for (const url of urls) {
            try {
                const { data } = await axios.get(url, { timeout: 10000 });
                const $ = cheerio.load(data, { xmlMode: true });
                const items = $('item').slice(0, 3); // 3 de cada fonte
                items.each((i, el) => {
                    const title = $(el).find('title').text();
                    const link = $(el).find('link').text();
                    const pubDate = $(el).find('pubDate').text();
                    let fonte = 'Google News';
                    if (url.includes('sciencedaily')) fonte = 'ScienceDaily';
                    noticias.push({ title, link, pubDate, fonte });
                });
                console.log(`✅ Fonte ${url} processada com sucesso`);
            } catch (error) {
                console.error(`⚠️ Erro ao processar fonte ${url}:`, error.message);
                // Continua para próxima fonte mesmo se uma falhar
            }
        }
        // Ordena por data (mais recente primeiro)
        noticias.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
        return noticias.slice(0, 5); // Top 5
    } catch (error) {
        console.error('❌ Erro ao buscar notícias:', error.message);
        return [];
    }
}

async function enviarNewsletterNutricao() {    let noticias = [];
    try {
        noticias = await buscarNoticiasNutricao();
    } catch (error) {
        console.error('❌ Erro ao buscar notícias:', error);
        await client.sendMessage(GROUP_ID, '⚠️ Não foi possível buscar as notícias agora. Tentarei novamente mais tarde.');
        return;
    }
    
    if (!noticias.length) {
        await client.sendMessage(GROUP_ID, '⚠️ Não há notícias de nutrição disponíveis no momento.');
        return;
    }
    let texto = '🥗 *NUTRI NEWS* 🥑\n\n';
    texto += 'Olá, grupo! Aqui estão as novidades mais quentes e confiáveis do mundo da Nutrição de hoje:\n\n';
    noticias.forEach((n, i) => {
        texto += `*${i + 1}.* ${n.title}\n🔗 ${n.link}\n📰 _Fonte: ${n.fonte}_\n\n`;
    });
    texto += '💡 _Dica do dia: Lembre-se de beber água e cuidar da sua alimentação!_\n';    texto += '\n🌐 *Fontes*: Google News e fontes especializadas em nutrição';
    texto += '\n\n💪 Se achou útil, compartilhe com amigos que se interessam por saúde e nutrição! 😉';
    await client.sendMessage(GROUP_ID, texto);
}

// Agendamento diário às 14:10
cron.schedule('10 14 * * *', () => {
    console.log('⏰ Enviando newsletter de nutrição...');
    enviarNewsletterNutricao();
});