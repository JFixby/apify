import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

await Actor.init();

const { 
    startUrls = [],
    maxRequestsPerCrawl = 100 
} = (await Actor.getInput()) ?? {};

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
        
        if (!url.includes('linkedin.com')) {
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

await crawler.run(startUrls);
await Actor.exit();
