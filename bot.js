const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const axios = require('axios');
const { traduzirPDF } = require('./pdf_translate');

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
    const palavrasChave = ['nutrição', 'nutricionista', 'dieta', 'alimentação', 'saúde', 'doença', 'exame', 'diagnóstico', 'tratamento', 'medicina', 'clinico', 'sintoma', 'paciente', 'consulta', 'protocolo', 'clinica'];
    function isRelevante(mensagem) {
        if (!mensagem) return false;
        const msg = mensagem.toLowerCase();
        return palavrasChave.some(palavra => msg.includes(palavra) && msg.length > 20);
    }
    try {
        const chat = await client.getChatById(groupId);
        const messages = await chat.fetchMessages({ limit });
        const mensagensRelevantes = messages.filter(msg => !msg.fromMe && !msg.body.startsWith('!') && isRelevante(msg.body));
        const resumoPorAutor = {};
        for (const msg of mensagensRelevantes) {
            const authorId = extrairAuthor(msg);
            if (!authorId) continue;
            const contact = await client.getContactById(authorId);
            const authorName = contact.pushname || contact.name || authorId.split('@')[0];
            if (!resumoPorAutor[authorName]) resumoPorAutor[authorName] = { mensagens: [], totalMensagens: 0 };
            resumoPorAutor[authorName].mensagens.push(truncarMensagem(msg.body));
            resumoPorAutor[authorName].totalMensagens++;
        }
        let resumo = `📝 *RESUMO TÉCNICO DAS CONVERSAS* 📝\n`;
        const autoresOrdenados = Object.entries(resumoPorAutor).sort((a, b) => b[1].totalMensagens - a[1].totalMensagens).slice(0, 5);
        for (const [nome, info] of autoresOrdenados) {
            resumo += `👤 *${nome}* (${info.totalMensagens} msgs):\n`;
            info.mensagens.slice(0, 3).forEach(msg => resumo += `   • ${msg}\n`);
            resumo += `\n`;
        }
        resumo += `📊 *Estatísticas*:\n   • Total analisado: ${messages.length}\n   • Relevantes: ${mensagensRelevantes.length}\n   • Tópicos: ${palavrasChave.join(', ')}\n_Gerado em ${new Date().toLocaleString()}_`;
        return resumo;
    } catch (error) {
        console.error("❌ Erro ao gerar resumo:", error);
        return `❌ Erro ao gerar resumo: ${error.message}`;
    }
}

async function enviarLinkTelegram(chatId) {
    await client.sendMessage(chatId, `📚 *PRECISA DE MATERIAL?*\nEntre no Telegram:\n🔗 https://t.me/+_AUQpTYNHy00MDhh`);
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
    const mensagem = `📚 *Novo pedido no WhatsApp:*\n👤 *Usuário:* ${nomeUsuario}\n📝 *Pedido:* ${pedido}\n🔗 https://t.me/+_AUQpTYNHy00MDhh`;
    await enviarAoTelegram(mensagem);
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox'] }
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
!traduzir - Traduzir PDF`);
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
!traduzir - Traduzir PDF`);
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
    await client.sendMessage(GROUP_ID, `❌ *ERRO CRÍTICO:* ${error.message}`);
    process.exit(1);
});

process.on('unhandledRejection', async (error) => {
    console.error('❌ Rejeição não tratada:', error);
    await client.sendMessage(GROUP_ID, `❌ *ERRO CRÍTICO:* ${error.message}`);
    process.exit(1);
});

console.log('🚀 Iniciando o bot...');
client.initialize();

setInterval(() => {
    const memTotal = Object.keys(membrosGrupo[GROUP_ID] || {}).length;
    console.log(`🕒 Bot rodando - ${new Date().toLocaleString()} - ${memTotal} membros`);
}, 3600000);