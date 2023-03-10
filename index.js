const { VK, API, Upload } = require('vk-io');
const { HearManager } = require('@vk-io/hear');
const { QuestionManager } = require('vk-io-question');

const config = require('./config.json');

const defaultConfigOptions = {
    logRequests: true,
    filterSources: true,
    filterLinks: true,
};

for (key of Object.keys(defaultConfigOptions)) {
    if (typeof config[key] === 'undefined') {
        config[key] = defaultConfigOptions[key];
    }
}

if (typeof config.responsesFile === 'undefined') {
    console.error('missing config option: responsesFile');
    process.exit(1);
}

const botResponses = require('./' + config.responsesFile);

const requiredBotResponses = [
    'triggerWord',
    'getDestination',
    'postNotFound',
    'invalidDestination',
    'getMessage',
    'messageSent',
    'scriptError',
];

for (o of requiredBotResponses) {
    if (typeof botResponses[o] === 'undefined') {
        console.error('missing bot response: ' + o);
        process.exit(1);
    }
}

const requiredEnvVariables = [
    'GROUP_ID',
    'TOKEN',
    'UTOKEN',
];

for (o of requiredEnvVariables) {
    if (typeof process.env[o] === 'undefined') {
        console.error('missing env variable: ' + o);
        process.exit(1);
    }
}

if (config.filterSources && process.env['WHITELIST'] === 'undefined') {
    console.error('missing env variable: WHITELIST');
    process.exit(1);
}

const triggerRegex = new RegExp(botResponses.triggerWord, 'i');
const linkRegex = /(?<=wall)(-?[0-9]*)_([0-9]*)(?:\?reply=([0-9]*))?/;
const linkSpamRegex = /(?:(http)s?:\/\/)?(?:[\w-]+\.)?[\w-]+(\.[\w-]+)(?:\/| |$)/g;

const communityIdWhitelist = (config.filterSources ? process.env.WHITELIST.split(",") : []);
for (let i = 0; i < communityIdWhitelist.length; i++)
    communityIdWhitelist[i] = parseInt(communityIdWhitelist[i]);
const groupId = parseInt(process.env.GROUP_ID);

const vk = new VK({
    token: process.env.TOKEN,
    pollingGroupId: process.env.GROUP_ID,
    webhookConfirmation: process.env.CONFIRMATION
});

const groupUpload = new Upload({
    api: vk.api
});

const userUpload = new Upload({
	api: new API({
        token: process.env.UTOKEN
    })
});

const questionManager = new QuestionManager();
const hearManager = new HearManager();

// rudimental change

vk.updates.use(questionManager.middleware);
vk.updates.on('message', hearManager.middleware);

hearManager.hear(triggerRegex, async (context) => {
    
    if (context.senderId === -groupId) {
        return;
    }
    try {
        const messageRequest = { from_group: groupId };
        const user = await vk.api.users.get({
            user_ids: context.senderId
        });

        if (user.length === 0) {
            console.log(`Incoming request from ??? ${context.senderId} ??? rejected`);
            return;
        }

        if (config.logRequests)
            console.log(`Incoming request from ${user[0].first_name} ${user[0].last_name} ??? ${context.senderId} ???`);

        // ---------------------- <Getting destination> ----------------------
        const dest_ctx = await context.question(botResponses.getDestination);
        link_rx_match = dest_ctx.text ? dest_ctx.text.match(linkRegex) : null;
        // link checking
        if (link_rx_match){
            messageRequest.owner_id = parseInt(link_rx_match[1]);
            messageRequest.post_id = parseInt(link_rx_match[2]);
            if (link_rx_match.length >= 4 && link_rx_match[3])
                messageRequest.reply_to_comment = parseInt(link_rx_match[3]);
        }
        // checking for attachments
        else if (dest_ctx.attachments.length > 0 && (dest_ctx.attachments[0].type === 'wall' || dest_ctx.attachments[0].type == 'wall_reply')){
            if (dest_ctx.attachments[0].type === 'wall'){
                messageRequest.owner_id = dest_ctx.attachments[0].ownerId;
                messageRequest.post_id = dest_ctx.attachments[0].id;
            }
            else {
                messageRequest.owner_id = dest_ctx.attachments[0].payload.owner_id;
                messageRequest.post_id = dest_ctx.attachments[0].payload.post_id;
                messageRequest.reply_to_comment = dest_ctx.attachments[0].payload.id;
            }
        }
        else {
            if (config.logRequests)
                console.log('Destination unknown.');
            await context.send(botResponses.postNotFound);
            return;
        }

        // ------ <Source filtering> ------
        if (config.filterSources) {
            if (!communityIdWhitelist.includes(messageRequest.owner_id)){
                if (config.logRequests)
                    console.log('Invalid destination.');
                await context.send(botResponses.invalidDestination);
                return;
            }
        }
        // ------ </Source filtering> ------

        // ---------------------- </Geting destination> ----------------------


        // ---------------------- <Geting message> ----------------------

        const msg = await context.question(botResponses.getMessage);
        
        // ------ <Attachments processing> ------

        if (msg.attachments.length > 0)
            messageRequest.attachments = '';
        if (msg.attachments.length){
            for (msgAttch of msg.attachments.slice(0,2)){
                if (msgAttch.type === 'audio')
                    messageRequest.attachments += `audio${msgAttch.ownerId}_${msgAttch.id},`;
                else if (msgAttch.type === 'video')
                    messageRequest.attachments += `video${msgAttch.ownerId}_${msgAttch.id},`;
                else if (msgAttch.type === 'photo'){
                    const attch = await userUpload.wallPhoto({
                        group_id: groupId,
                        source: {
                            value: msgAttch.mediumSizeUrl
                        }
                    });
                    messageRequest.attachments += attch+',';
                }
                else if (msgAttch.type === 'doc'){
                    const attch = await groupUpload.wallDocument({
                        group_id: groupId,
                        source: {
                            value: msgAttch.url
                        }
                    });
                    messageRequest.attachments += attch+`,`;
                }
                else if (msgAttch.type === 'sticker')
                    messageRequest.sticker_id = msgAttch.id;
            }
            messageRequest.attachments = messageRequest.attachments.slice(0,-1);
        }
        // ------ </Attachments processing> ------

        // ------ <link filtering> ------
        if (config.filterLinks) {
            messageRequest.message = msg.text || '';
            for (let lkrx of messageRequest.message.matchAll(linkSpamRegex))
                for (let chstr of lkrx.slice(1))
                    if (chstr) 
                        messageRequest.message = messageRequest.message.replace(chstr, '****'); 
        }
        // ------ </link filtering> ------

        // ---------------------- </Getting message> ----------------------


        // ---------------------- <Sending message> ----------------------
        
        const response = await vk.api.wall.createComment(messageRequest);

        // ---------------------- </Sending message> ----------------------

        // ---------------------- <Sending response> ----------------------
        if (config.logRequests){
            console.log(messageRequest);
            console.log(`Comment adress: https://vk.com/wall${messageRequest.owner_id}_${messageRequest.post_id}?reply=${response.comment_id}`);
        }
        context.send(botResponses.messageSent);
        // ---------------------- <Sending response> ----------------------
    }
    catch(e) {
        console.error(e);
        context.send(botResponses.scriptError);
    } finally {
        console.log('-------------------------------------');
    }
});

console.log('Bot started.');
const port = process.env.PORT || 3000;
if (process.env.NODE_ENV === 'prod') {
    vk.updates.start({
        webhook: {
            port: port
        }
    });
} else {
    console.log('Starting long polling');
    vk.updates.startPolling();
}