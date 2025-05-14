const fs = require('fs');
const axios = require('axios');
const pdfParse = require('pdf-parse');

// Função para extrair texto de um PDF
async function extrairTextoPDF(caminhoPDF) {
    const dataBuffer = fs.readFileSync(caminhoPDF);
    const data = await pdfParse(dataBuffer);
    return data.text;
}

// Função para traduzir texto usando Google Translate
async function traduzirParaPortugues(texto) {
    try {
        const response = await axios.post('https://translate.googleapis.com/translate_a/single', null, {
            params: {
                client: 'gtx',
                sl: 'auto',
                tl: 'pt',
                dt: 't',
                q: texto
            },
            timeout: 30000
        });

        // O Google Translate retorna um array com as traduções
        const traducao = response.data[0]
            .map(item => item[0])
            .filter(Boolean)
            .join(' ');

        return traducao;
    } catch (error) {
        console.error('Erro na tradução:', error.message);
        throw new Error('Falha na tradução. Por favor, tente novamente mais tarde.');
    }
}

// Função principal: extrai e traduz o PDF
async function traduzirPDF(caminhoPDF) {
    try {
        console.log('Extraindo texto do PDF...');
        const texto = await extrairTextoPDF(caminhoPDF);
        console.log('Texto extraído com sucesso!');

        // Divide o texto em blocos menores para evitar limites da API
        const tamanhoBloco = 4000; // Google Translate aceita textos maiores
        let resultado = '';
        const totalBlocos = Math.ceil(texto.length / tamanhoBloco);

        for (let i = 0; i < texto.length; i += tamanhoBloco) {
            const blocoAtual = Math.floor(i / tamanhoBloco) + 1;
            console.log(`Traduzindo bloco ${blocoAtual}/${totalBlocos}...`);
            
            const bloco = texto.substring(i, i + tamanhoBloco);
            const traducao = await traduzirParaPortugues(bloco);
            resultado += traducao + '\n';
            
            // Pequena pausa entre as requisições para evitar bloqueio
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log('Tradução concluída com sucesso!');
        return resultado;
    } catch (error) {
        console.error('Erro ao processar PDF:', error);
        throw error;
    }
}

module.exports = {
    extrairTextoPDF,
    traduzirParaPortugues,
    traduzirPDF
}; 