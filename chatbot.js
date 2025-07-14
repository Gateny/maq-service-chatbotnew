// Importações de módulos necessários
const http = require('http'); // Para criar o servidor HTTP para o Render
const qrcode = require('qrcode-terminal'); // Para gerar o QR Code no terminal
const { Client, RemoteAuth } = require('whatsapp-web.js'); // Cliente do WhatsApp e estratégia de autenticação remota
const mongoose = require('mongoose'); // Para interagir com o MongoDB

// --- VARIÁVEIS GLOBAIS ---
// Objeto para armazenar o estado da conversa de cada usuário
const userState = {};

// Função auxiliar para delays (esperas) assíncronos
const delay = ms => new Promise(res => setTimeout(res, ms));

// Variável para a instância do cliente WhatsApp (declarada globalmente para ser acessível)
let client;

// Variável para a estratégia de armazenamento da sessão do WhatsApp (MongoDB)
let currentStore; 

// --- SERVIDOR HTTP BÁSICO PARA O RENDER ---
// Define a porta, usando a variável de ambiente do Render (PORT) ou 3000 como padrão
const PORT = process.env.PORT || 3000; 

// Cria um servidor HTTP básico. O Render exige que sua aplicação escute em uma porta.
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Chatbot is running!\n'); // Mensagem simples para quando alguém acessar a URL do seu bot
});

// Faz o servidor escutar na porta definida
server.listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
});

// --- MODELO MONGOOSE PARA SESSÕES DO WHATSAPP-WEB.JS ---
// Define o esquema e o modelo para armazenar as sessões do WhatsApp no MongoDB
const WWebJsSession = mongoose.model('WWebJsSession', new mongoose.Schema({
    _id: String, // O ID da sessão (usaremos 'whatsapp' como ID fixo)
    data: Object // Os dados da sessão em si
}));

// --- CONEXÃO COM MONGODB E INICIALIZAÇÃO DO BOT ---
// Obtém a URI de conexão do MongoDB das variáveis de ambiente do Render
const MONGODB_URI = process.env.MONGODB_URI;

// Verifica se a URI do MongoDB foi definida
if (!MONGODB_URI) {
    console.error('ERRO: Variável de ambiente MONGODB_URI não definida. O bot NÃO persistirá a sessão.');
    // Se a URI não estiver definida, inicializa o bot sem persistência
    initializeWhatsAppClient(null); // Passa null para o store
} else {
    // Tenta conectar ao MongoDB
    mongoose.connect(MONGODB_URI)
        .then(() => {
            console.log('Conectado ao MongoDB com sucesso!');
            // Cria a instância do store personalizado para o RemoteAuth
            currentStore = {
                session: null, // Variável interna para armazenar os dados da sessão

                // Método load(): Carrega a sessão do MongoDB
                async load() {
                    console.log('Tentando carregar sessão do MongoDB...');
                    const sessionDoc = await WWebJsSession.findById('whatsapp'); // Busca a sessão com ID 'whatsapp'
                    if (sessionDoc) {
                        this.session = sessionDoc.data; // Atribui os dados encontrados
                        console.log('Sessão carregada do MongoDB com sucesso!');
                    } else {
                        console.log('Nenhuma sessão encontrada no MongoDB.');
                        this.session = null; // Nenhuma sessão para carregar
                    }
                    return this.session; // Retorna os dados da sessão
                },

                // Método save(session): Salva a sessão no MongoDB
                async save(session) {
                    await WWebJsSession.findByIdAndUpdate('whatsapp', { _id: 'whatsapp', data: session }, { upsert: true, new: true });
                    this.session = session; // Atualiza a variável interna
                    console.log('Sessão salva no MongoDB com sucesso!');
                },

                // Método extract(): Extrai os dados da sessão (para salvar)
                extract() {
                    return this.session;
                },

                // Método reset(): Limpa a sessão no MongoDB
                async reset() {
                    await WWebJsSession.findByIdAndDelete('whatsapp');
                    this.session = null;
                    console.log('Sessão resetada no MongoDB.');
                }
            };
            // Chama a inicialização do cliente WhatsApp APÓS a conexão com o DB e configuração do store
            initializeWhatsAppClient(currentStore);
        })
        .catch(err => {
            console.error('Erro ao conectar ao MongoDB:', err.message); // Imprime a mensagem de erro específica
            console.error('Verifique a MONGODB_URI (usuário/senha/IP) nas variáveis de ambiente do Render e no MongoDB Atlas.');
            // Em caso de erro no DB, ainda tenta iniciar o bot, mas sem persistência (pedirá QR code sempre)
            initializeWhatsAppClient(null); // Passa null para o store
        });
}

// --- FUNÇÃO PARA INICIALIZAR O CLIENTE WHATSAPP ---
// Esta função encapsula a lógica de inicialização e eventos do WhatsApp
function initializeWhatsAppClient(sessionStore) {
    console.log('Chamando initializeWhatsAppClient...'); // Log de depuração

    // Cria a instância do cliente WhatsApp
    client = new Client({
        // Se houver um sessionStore, usa RemoteAuth para persistência
        authStrategy: sessionStore ? new RemoteAuth({ store: sessionStore, clientId: 'whatsapp' }) : undefined, 
        // Configurações do Puppeteer para otimização de recursos no ambiente de nuvem
        puppeteer: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Importante para ambientes de contêineres/nuvem
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // Pode causar instabilidade, mas economiza RAM
                '--disable-gpu',
                '--disable-infobars',
                '--window-size=1280,720', // Define um tamanho fixo da janela
                '--lang=en-US' // Define o idioma
            ],
          
        }
    });

    // --- EVENTOS DO CLIENTE WHATSAPP ---
    // Evento: QR Code gerado
    client.on('qr', qr => {
        qrcode.generate(qr, { small: true });
        console.log('QR Code gerado. Escaneie-o para continuar.');
    });

    // Evento: Cliente pronto e conectado
    client.on('ready', () => {
        console.log('Tudo certo! WhatsApp da MAQ SERVICE conectado.');
    });

    // Evento: Cliente desconectado
    client.on('disconnected', (reason) => {
        console.log('Cliente desconectado!', reason);
        // Destroi o cliente atual e tenta reinicializar após um pequeno atraso
        client.destroy(); 
        setTimeout(() => initializeWhatsAppClient(sessionStore), 5000); // Tenta inicializar novamente após 5s
    });

    // --- FUNIL DE ATENDIMENTO MAQ SERVICE ---
    client.on('message', async msg => {
        // Ignora mensagens de grupos ou que não são de usuários reais (c.us)
        if (!msg.from.endsWith('@c.us')) return;

        const chat = await msg.getChat();
        const user = msg.from;
        const contact = await msg.getContact();
        const userName = contact.pushname ? contact.pushname.split(" ")[0] : 'Cliente';
        const messageBody = msg.body.trim(); // .trim() remove espaços extras

        // COMANDO GLOBAL PARA VOLTAR AO MENU
        if (messageBody.match(/^(menu|voltar|menu principal|cancelar)$/i)) {
            delete userState[user]; // Limpa o estado do usuário
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

                const summary = `Obrigado pelas informações! Seu pedido foi registrado com sucesso:\n\n*Eletrodoméstico:* ${userState[user].map_service_chatbot_data.appliance}\n*Marca/Modelo:* ${userState[user].map_service_chatbot_data.model}\n*Problema:* ${userState[user].map_service_chatbot_data.problem}\n\nEm breve, um de nossos técnicos entrará em contato.\n\nNosso horário de atendimento é de *Segunda a Sábado, das 07h às 18h*.`;
                
                await client.sendMessage(user, summary);
                delete userState[user]; // Limpa o estado para o próximo atendimento
                return; 
            }
        }

        // --- FLUXO PRINCIPAL E MENU ---

        // Gatilho para iniciar a conversa (se não estiver em um fluxo)
        // Alterado para reagir a "oi", "ola", "bom dia", "boa tarde", "boa noite" se o usuário não estiver em um fluxo
        if (messageBody.match(/^(oi|ola|olá|bom dia|boa tarde|boa noite|tenho interesse no serviço da maq service\.?)$/i) && !userState[user]) {
            await chat.sendStateTyping();
            await delay(1500);
            await sendMainMenu(user, userName);
            return;
        }


        // Respostas baseadas na seleção NUMÉRICA
        if (!userState[user]) { // Só processa as opções se o usuário não estiver em um fluxo de dados
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

                default: // Resposta padrão para opções inválidas fora de um fluxo
                    // Adicionado um pequeno atraso e mensagem para opções inválidas
                    await chat.sendStateTyping();
                    await delay(1000);
                    await client.sendMessage(user, `Desculpe, não entendi. Por favor, digite o *número* da opção desejada ou *Menu* para voltar ao menu principal.`);
                    break;
            }
        }
    });

    // Inicia o cliente WhatsApp
    client.initialize(); 
}

// Função para enviar o menu principal em formato de texto (declarada globalmente)
async function sendMainMenu(chatId, userName) {
    const menuMessage = `Olá, ${userName}! 👋 Sou o assistente virtual da *MAQ SERVICE*.\n\nSe você deseja adiantar o assunto, por favor, *digite o número* da opção desejada:\n\n*1* - Solicitar Orçamento/Visita Técnica\n*2* - Consultar Serviços Oferecidos\n*3* - Falar com o Proprietário`;
    await client.sendMessage(chatId, menuMessage);
}