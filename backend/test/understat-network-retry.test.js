const test = require('node:test');
const assert = require('node:assert/strict');
const { UnderstatScraper } = require('../dist/services/UnderstatScraper');
test('Understat recovers transient DNS and upstream errors without changing payload', async () => {
 const scraper=new UnderstatScraper(); let calls=0;
 const payload={dates:[]}; scraper.client.get=async()=>{calls++;if(calls===1)throw Object.assign(new Error('dns'),{code:'EAI_AGAIN'});if(calls===2)throw {response:{status:503}};return {data:payload};};
 assert.equal(await scraper.fetchJson('/test'),payload);assert.equal(calls,3);
});
test('Understat stops after three transient failures and preserves the failure', async () => {
 const scraper=new UnderstatScraper();let calls=0;const failure=Object.assign(new Error('reset'),{code:'ECONNRESET'});
 scraper.client.get=async()=>{calls++;throw failure;};
 await assert.rejects(scraper.fetchJson('/test'),error=>error===failure);assert.equal(calls,3);
});
test('Understat never retries permanent HTTP errors or rate limits',async()=>{
 for(const status of [401,403,404,429]){const scraper=new UnderstatScraper();let calls=0;const failure={response:{status}};
 scraper.client.get=async()=>{calls++;throw failure;};await assert.rejects(scraper.fetchJson('/test'),error=>error===failure);assert.equal(calls,1);}
});
