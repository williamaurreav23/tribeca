const crypto = require('crypto');

const API_SECRET = '82f192d903f363f22a031dfdbbeaf851';
const api_key = 'fd91cd9ba2cc78fed6bb40e0bcff29ba';

const generateMessage = (url, params) => {
    let message = url + '?';
    Object.keys(params).sort().forEach((key) => {
        message = `${message}${key}=${params[key]}&`;
    });
    return message.substring(0, message.length - 1);
}

const generateSignedUrl = (url, params) => {
    const message = generateMessage(url, params);
    const signature = crypto.createHmac('SHA256', API_SECRET).update(message).digest('hex');
    return `${message}&signData=${signature}`
}

module.exports = {
    generateMessage: generateMessage,
    generateSignedUrl: generateSignedUrl
}