#!/usr/bin/env node
/**
 * Test the chatbot API with new intents
 */
const http = require('http');

const testQuestions = [
  "What are the fees?",
  "How much does studying cost?",
  "Can I get financial help?",
  "How do I apply?",
  "Where can I live?",
  "Tell me about the library",
  "I need mental health support",
  "What careers support is available?",
  "What postgraduate courses do you have?",
  "Where are your campuses?",
  "What undergraduate courses do you offer?",
  "What student services do you provide?",
  "Faint yw'r ffioedd?"
];

function testChatbot(question) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ message: question });

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          resolve({
            question,
            tag: response.tag,
            confidence: response.confidence,
            response: response.response.substring(0, 60) + '...'
          });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log('Testing U-Pal Chatbot with new intents...\n');
  console.log('Question | Tag | Confidence | Response\n' + '-'.repeat(80));
  
  for (const question of testQuestions) {
    try {
      const result = await testChatbot(question);
      console.log(`${result.question.substring(0, 20).padEnd(20)} | ${result.tag.padEnd(20)} | ${(result.confidence * 100).toFixed(0)}% | ${result.response}`);
    } catch (err) {
      console.error(`Error testing "${question}":`, err.message);
    }
    // Small delay between requests
    await new Promise(r => setTimeout(r, 100));
  }
}

// Wait for server to be ready
setTimeout(() => {
  runTests().catch(console.error);
}, 1000);
