import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const { 
    profileUrls = [],
    maxRequestsPerCrawl = 100 
} = input;

if (profileUrls.length === 0) {
    Actor.log.warning('No profileUrls provided in input!');
}

Actor.log.info(`Starting with ${profileUrls.length} LinkedIn profile URLs`);
if (profileUrls.length > 0) {
    Actor.log.info(`First URL: ${profileUrls[0]}`);
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

Actor.log.info(`Running crawler with ${profileUrls.length} profile URLs`);
await crawler.run(profileUrls);
await Actor.exit();
