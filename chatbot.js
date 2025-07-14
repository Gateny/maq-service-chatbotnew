// Importa apenas o Client, pois não usaremos botões ou listas
const qrcode = require('qrcode-terminal');
const { Client } = require('whatsapp-web.js');
const client = new Client();

// Objeto para armazenar o estado da conversa de cada usuário (esta lógica permanece)
const userState = {};

// Função para enviar o menu principal em formato de texto
async function sendMainMenu(chatId, userName) {
    const menuMessage = `Olá, ${userName}! 👋 Sou o assistente virtual da *MAQ SERVICE*.\n\nSe você deseja adiantar o assunto, por favor, *digite o número* da opção desejada:\n\n*1* - Solicitar Orçamento/Visita Técnica\n*2* - Consultar Serviços Oferecidos\n*3* - Falar com o Proprietário`;
    await client.sendMessage(chatId, menuMessage);
}

// Serviço de leitura do qr code
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

// Mensagem de confirmação quando o bot está online
client.on('ready', () => {
    console.log('Tudo certo! WhatsApp da MAQ SERVICE conectado.');
});

// Inicializa o cliente
client.initialize();

const delay = ms => new Promise(res => setTimeout(res, ms));

// Funil de Atendimento MAQ SERVICE
client.on('message', async msg => {
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