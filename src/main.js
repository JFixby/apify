import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
let { 
    startUrls = [],
    maxRequestsPerCrawl = 100 
} = input;

if (startUrls.length === 0) {
    Actor.log.warning('No startUrls provided in input!');
}

Actor.log.info(`Starting with ${startUrls.length} URLs`);
if (startUrls.length > 0) {
    const firstUrl = typeof startUrls[0] === 'string' ? startUrls[0] : startUrls[0].url;
    Actor.log.info(`First URL: ${firstUrl}`);
}

const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
});

const extractLinkedInData = ($, url, log) => {
    const data = {
        url,
        fullName: $('h1').first().text().trim() || $('title').text().split('|')[0].trim(),
        headline: $('h2[class*="headline"]').first().text().trim() || '',
        location: $('span[class*="location"]').first().text().trim() || '',
        about: $('[class*="about"]').first().text().trim() || '',
    };

    log.info(`Extracted: ${data.fullName}`, { url });
    return data;
};

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ enqueueLinks, request, $, log }) {
        const url = request.loadedUrl;
        
        log.info(`Processing: ${url}`);
        
        if (!url.includes('linkedin.com')) {
            log.warning(`Skipping non-LinkedIn URL: ${url}`);
            return;
        }

        await enqueueLinks({
            selector: 'a[href*="linkedin.com/in/"], a[href*="linkedin.com/profile/"]',
        });

        const data = extractLinkedInData($, url, log);
        
        if (data.fullName) {
            await Dataset.pushData(data);
        }
    },
});

Actor.log.info(`Running crawler with ${startUrls.length} start URLs`);
await crawler.run(startUrls);
await Actor.exit();
