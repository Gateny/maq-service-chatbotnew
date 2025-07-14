// Importações de módulos necessários
const http = require('http'); // Para criar o servidor HTTP para o Render
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino'); // Para logs do Baileys
const qrcode = require('qrcode-terminal')

// --- VARIÁVEIS GLOBAIS ---
// Objeto para armazenar o estado da conversa de cada usuário
const userState = {};

// Função auxiliar para delays (esperas) assíncronos
const delay = ms => new Promise(res => setTimeout(res, ms));

// --- SERVIDOR HTTP BÁSICO PARA O RENDER ---
// Define a porta, usando a variável de ambiente do Render (PORT) ou 3000 como padrão
const PORT = process.env.PORT || 3000; 

// Cria um servidor HTTP básico. O Render exige que sua aplicação escute em uma porta.
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Chatbot is running with Baileys!\n'); // Mensagem atualizada para Baileys
});

// Faz o servidor escutar na porta definida
server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

// --- FUNÇÃO PRINCIPAL DE INICIALIZAÇÃO DO BOT BAILLEYS ---
async function startBot() {
    // Para persistência de sessão (inicialmente em arquivos, para simplificar)
    // Para persistir em DB como MongoDB, será preciso adaptar esta parte.
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    // Cria a instância do socket do Baileys
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }), // Nível de log do Baileys (silent para menos logs)
        auth: state, // Estado da autenticação
        browser: ['Chatbot MAQ SERVICE', 'Chrome', '10.0'], // Informações do navegador (customizável)
    });

    // --- EVENTOS DO BAILLEYS ---

    // Evento: Estado da conexão
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
    // Se um QR code for gerado, imprima-o (precisará escanear no primeiro uso)
    console.log('QR Code para Baileys gerado. Escaneie-o para continuar:');
    // qrcode.generate(qr, { small: true }); // Baileys já imprime se printQRInTerminal for true
    // Ou você pode usar qrcode-terminal aqui se quiser um visual específico
}

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log('Conexão fechada. Motivo:', lastDisconnect.error, 'Reconectar?', shouldReconnect);
            // Tenta reconectar se não foi um logout intencional
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Bot MAQ SERVICE conectado com sucesso (Baileys)!');
        }
    });

    // Evento: Credenciais atualizadas (importante para persistência)
    sock.ev.on('creds.update', saveCreds);

    // Evento: Nova mensagem recebida
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (!msg.key.fromMe && !msg.key.remoteJid.endsWith('@g.us')) { // Ignora minhas mensagens e mensagens de grupo
                    // Processar a mensagem
                    const senderId = msg.key.remoteJid;
                    const messageBody = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                    const pushName = msg.pushName || 'Cliente';

                    console.log(`Mensagem de ${pushName} (${senderId}): ${messageBody}`);

                    // Chame sua lógica de funil de atendimento aqui
                    await processMessage(sock, senderId, messageBody.trim(), pushName);
                }
            }
        }
    });

    return sock; // Retorna a instância do socket
}

// --- LÓGICA DE FUNIL DE ATENDIMENTO (ADAPTADA PARA BAILLEYS) ---
async function processMessage(sock, chatId, messageBody, userName) {
    // COMANDO GLOBAL PARA VOLTAR AO MENU
    if (messageBody.match(/^(menu|voltar|menu principal|cancelar)$/i)) {
        delete userState[chatId]; // Usa chatId como key para o estado do usuário
        // O Baileys não tem sendStateTyping direto para conversas
        await delay(1000); 
        await sendMainMenu(sock, chatId, userName);
        return;
    }

    // ESTÁGIOS DA CONVERSA PARA COLETAR DADOS
    if (userState[chatId]) {
        const stage = userState[chatId].stage;

        if (stage === 'awaiting_appliance') {
            userState[chatId].data.appliance = messageBody;
            userState[chatId].stage = 'awaiting_model';
            await sock.sendMessage(chatId, { text: `✅ Aparelho anotado! Agora, por favor, informe a *marca e o modelo*.\n\n*Exemplo: Brastemp Clean BWG11A*\n\n_(Para cancelar, digite *Menu*)_` });
            return;
        }

        if (stage === 'awaiting_model') {
            userState[chatId].data.model = messageBody;
            userState[chatId].stage = 'awaiting_problem';
            await sock.sendMessage(chatId, { text: `✅ Modelo anotado! Para finalizar, por favor, *descreva o problema* que você está enfrentando.\n\n_(Para cancelar, digite *Menu*)_` });
            return;
        }
        
        if (stage === 'awaiting_problem') {
            userState[chatId].data.problem = messageBody;
            await delay(2000);

            const summary = `Obrigado pelas informações! Seu pedido foi registrado com sucesso:\n\n*Eletrodoméstico:* ${userState[chatId].data.appliance}\n*Marca/Modelo:* ${userState[chatId].data.model}\n*Problema:* ${userState[chatId].data.problem}\n\nEm breve, um de nossos técnicos entrará em contato.\n\nNosso horário de atendimento é de *Segunda a Sábado, das 07h às 18h*.`;
            
            await sock.sendMessage(chatId, { text: summary });
            delete userState[chatId]; // Limpa o estado para o próximo atendimento
            return; 
        }
    }

    // --- FLUXO PRINCIPAL E MENU ---

    // Gatilho para iniciar a conversa (se não estiver em um fluxo)
    if (messageBody.match(/^(oi|ola|olá|bom dia|boa tarde|boa noite|tenho interesse no serviço da maq service\.?)$/i) && !userState[chatId]) {
        await delay(1500);
        await sendMainMenu(sock, chatId, userName);
        return;
    }

    // Respostas baseadas na seleção NUMÉRICA
    if (!userState[chatId]) {
        switch(messageBody) {
            case '1':
                userState[chatId] = { stage: 'awaiting_appliance', data: {} };
                await sock.sendMessage(chatId, { text: `Ok, vamos iniciar seu pedido de orçamento.\n\nPrimeiro, informe qual o eletrodoméstico precisa de conserto?\n\n*Ex: Máquina de Lavar, Ventilador, etc.*\n\n_(Para cancelar, digite *Menu*)_` });
                break;

            case '2':
                await delay(1500);
                const servicesMessage = `Somos especialistas no conserto e manutenção de:\n\n✅ Máquinas de lavar roupa\n✅ Tanquinhos (Lavadoras semiautomáticas)\n✅ Centrífugas de roupa\n✅ Ventiladores de todos os tipos\n\nPara solicitar um serviço, digite *Menu* e depois a opção *1*.`;
                await sock.sendMessage(chatId, { text: servicesMessage });
                break;

            case '3':
                await delay(1500);
                await sock.sendMessage(chatId, { text: `Certo. Sua mensagem será encaminhada para o proprietário. Por favor, aguarde que ele responderá assim que possível aqui mesmo.` });
                break;

            default: // Resposta padrão para opções inválidas fora de um fluxo
                await delay(1000);
                await sock.sendMessage(chatId, { text: `Desculpe, não entendi. Por favor, digite o *número* da opção desejada ou *Menu* para voltar ao menu principal.` });
                break;
        }
    }
}

// Função para enviar o menu principal em formato de texto
async function sendMainMenu(sock, chatId, userName) {
    const menuMessage = `Olá, ${userName}! 👋 Sou o assistente virtual da *MAQ SERVICE*.\n\nSe você deseja adiantar o assunto, por favor, *digite o número* da opção desejada:\n\n*1* - Solicitar Orçamento/Visita Técnica\n*2* - Consultar Serviços Oferecidos\n*3* - Falar com o Proprietário`;
    await sock.sendMessage(chatId, { text: menuMessage });
}

// Inicia o bot
startBot();