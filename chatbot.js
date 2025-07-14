const http = require('http');
const qrcode = require('qrcode-terminal');
const { Client, RemoteAuth } = require('whatsapp-web.js'); // Importe RemoteAuth aqui
const mongoose = require('mongoose');
const { MongoStore } = require('whatsapp-web.js-mongodb'); // Importe MongoStore aqui

// --- Configuração da Persistência de Sessão ---
let store; // Declarar 'store' fora do escopo do then/catch
// URL de conexão do MongoDB (você vai definir isso nas Variáveis de Ambiente do Render)
const MONGODB_URI = process.env.MONGODB_URI;

// --- Configuração do Servidor HTTP (para manter o Render ativo) ---
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Chatbot is running!\n');
});
server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

// --- Bloco de Conexão com MongoDB e Inicialização do Bot ---
if (!MONGODB_URI) {
    console.error('ERRO: Variável de ambiente MONGODB_URI não definida. O bot não persistirá a sessão.');
    // Se MONGODB_URI não estiver definido, inicializa o bot sem persistência.
    // Isso é bom para desenvolvimento, mas não para 24/7.
    initializeWhatsAppClient(null); // Passa null para store
} else {
    mongoose.connect(MONGODB_URI)
        .then(() => {
            console.log('Conectado ao MongoDB com sucesso!');
            store = new MongoStore({ mongoose: mongoose, collectionName: 'sessions' }); // Define a coleção das sessões
            initializeWhatsAppClient(store); // Chama a inicialização do bot APÓS a conexão com o DB, passando o store
        })
        .catch(err => {
            console.error('Erro ao conectar ao MongoDB:', err);
            // Em caso de erro no DB, ainda tenta iniciar o bot, mas sem persistência
            initializeWhatsAppClient(null); // Passa null para store
        });
}

// --- Função para inicializar o cliente do WhatsApp ---
// Esta função agora recebe 'currentStore' como argumento
function initializeWhatsAppClient(currentStore) {
    console.log('Tentando conectar ao WhatsApp...'); // Nova linha para depuração

    const client = new Client({
        authStrategy: currentStore ? new RemoteAuth({ store: currentStore, clientId: 'whatsapp' }) : undefined, // Usa RemoteAuth com o store
        puppeteer: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-infobars',
                '--window-size=1280,720',
                '--lang=en-US'
            ],
            executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
        }
    });

    client.on('qr', qr => {
        qrcode.generate(qr, { small: true });
        console.log('QR Code gerado. Escaneie-o para continuar.');
    });

    client.on('ready', () => {
        console.log('Tudo certo! WhatsApp da MAQ SERVICE conectado.');
    });

    client.on('disconnected', (reason) => {
        console.log('Cliente desconectado!', reason);
        // Implementar lógica de reconexão se necessário
        client.destroy();
        setTimeout(() => initializeWhatsAppClient(currentStore), 5000); // Tenta inicializar novamente após 5s
    });

    // --- Seu Funil de Atendimento MAQ SERVICE ---
    client.on('message', async msg => {
        if (!msg.from.endsWith('@c.us')) return;

        const chat = await msg.getChat();
        const user = msg.from;
        const contact = await msg.getContact();
        const userName = contact.pushname ? contact.pushname.split(" ")[0] : 'Cliente';
        const messageBody = msg.body.trim();

        // COMANDO GLOBAL PARA VOLTAR AO MENU
        if (messageBody.match(/^(menu|voltar|menu principal|cancelar)$/i)) {
            delete userState[user];
            await chat.sendStateTyping();
            await delay(1000);
            await sendMainMenu(user, userName);
            return;
        }

        // ESTÁGIOS DA CONVERSA PARA COLETAR DADOS
        if (userState[user]) {
            const stage = userState[user].stage;

            if (stage === 'awaiting_appliance') {
                userState[user].data.appliance = messageBody;
                userState[user].stage = 'awaiting_model';
                await client.sendMessage(user, `✅ Aparelho anotado! Agora, por favor, informe a *marca e o modelo*.\n\n*Exemplo: Brastemp Clean BWG11A*\n\n_(Para cancelar, digite *Menu*)_`);
                return;
            }

            if (stage === 'awaiting_model') {
                userState[user].data.model = messageBody;
                userState[user].stage = 'awaiting_problem';
                await client.sendMessage(user, `✅ Modelo anotado! Para finalizar, por favor, *descreva o problema* que você está enfrentando.\n\n_(Para cancelar, digite *Menu*)_`);
                return;
            }
            
            if (stage === 'awaiting_problem') {
                userState[user].data.problem = messageBody;
                await chat.sendStateTyping();
                await delay(2000);

                const summary = `Obrigado pelas informações! Seu pedido foi registrado com sucesso:\n\n*Eletrodoméstico:* ${userState[user].data.appliance}\n*Marca/Modelo:* ${userState[user].data.model}\n*Problema:* ${userState[user].data.problem}\n\nEm breve, um de nossos técnicos entrará em contato.\n\nNosso horário de atendimento é de *Segunda a Sábado, das 07h às 18h*.`;
                
                await client.sendMessage(user, summary);
                delete userState[user]; // Limpa o estado para o próximo atendimento
                return; 
            }
        }

        // --- FLUXO PRINCIPAL E MENU ---

        // Gatilho para iniciar a conversa (se não estiver em um fluxo)
        if (messageBody.match(/(Tenho interesse no serviço da MAQ SERVICE.)/i) && !userState[user]) {
            await chat.sendStateTyping();
            await delay(1500);
            await sendMainMenu(user, userName);
            return;
        }

        // Respostas baseadas na seleção NUMÉRICA
        if (!userState[user]) {
            switch(messageBody) {
                case '1':
                    userState[user] = { stage: 'awaiting_appliance', data: {} };
                    await client.sendMessage(user, `Ok, vamos iniciar seu pedido de orçamento.\n\nPrimeiro, informe qual o eletrodoméstico precisa de conserto?\n\n*Ex: Máquina de Lavar, Ventilador, etc.*\n\n_(Para cancelar, digite *Menu*)_`);
                    break;

                case '2':
                    await chat.sendStateTyping();
                    await delay(1500);
                    const servicesMessage = `Somos especialistas no conserto e manutenção de:\n\n✅ Máquinas de lavar roupa\n✅ Tanquinhos (Lavadoras semiautomáticas)\n✅ Centrífugas de roupa\n✅ Ventiladores de todos os tipos\n\nPara solicitar um serviço, digite *Menu* e depois a opção *1*.`;
                    await client.sendMessage(user, servicesMessage);
                    break;

                case '3':
                    await chat.sendStateTyping();
                    await delay(1500);
                    await client.sendMessage(user, `Certo. Sua mensagem será encaminhada para o proprietário. Por favor, aguarde que ele responderá assim que possível aqui mesmo.`);
                    break;
            }
        }
    });

    client.initialize(); // Esta linha deve ser a ÚLTIMA chamada no escopo da função initializeWhatsAppClient

    // Objeto para armazenar o estado da conversa de cada usuário (esta lógica permanece)
    const userState = {}; // Mover esta declaração para o escopo global se for usada em client.on('message')
    // ou dentro de initializeWhatsAppClient e passá-la como argumento se for para ser por instância do client.
    // Pelo seu código, ela parece ser global, então pode ficar no início do arquivo.
    
    // Função para enviar o menu principal em formato de texto
    async function sendMainMenu(chatId, userName) {
        const menuMessage = `Olá, ${userName}! 👋 Sou o assistente virtual da *MAQ SERVICE*.\n\nSe você deseja adiantar o assunto, por favor, *digite o número* da opção desejada:\n\n*1* - Solicitar Orçamento/Visita Técnica\n*2* - Consultar Serviços Oferecidos\n*3* - Falar com o Proprietário`;
        await client.sendMessage(chatId, menuMessage);
    }
    const delay = ms => new Promise(res => setTimeout(res, ms)); // Mover para o escopo global ou dentro de initializeWhatsAppClient
}