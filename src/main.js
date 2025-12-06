import { Actor } from 'apify';
import { CheerioCrawler, Dataset, RequestQueue } from 'crawlee';

await Actor.init();

const { 
    startUrls = ['https://apify.com'], 
    scrapingMode = 'auto',
    extractMAData = true,
    discoverInvestors = false,
    maxRequestsPerCrawl = 100 
} = (await Actor.getInput()) ?? {};

const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
});

const detectUrlType = (url) => {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    const pathname = urlObj.pathname.toLowerCase();
    
    if (hostname.includes('linkedin.com')) {
        if (pathname.includes('/in/') || pathname.includes('/profile/')) {
            return 'linkedin-profile';
        }
        return 'linkedin';
    }
    if (hostname.includes('crunchbase.com')) {
        if (pathname.includes('/person/') || pathname.includes('/investor') || pathname.includes('/people/')) {
            return 'investor';
        }
        if (pathname.includes('/search/') || pathname.includes('/discover/') || 
            pathname.includes('/people') || pathname.includes('/person')) {
            return 'investor-search';
        }
        return 'crunchbase';
    }
    return 'unknown';
};

const extractInvestorLinks = ($, url, log) => {
    const investorLinks = [];
    
    $('a[href*="/person/"], a[href*="/people/"], a[href*="/investor"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
            const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
            if (fullUrl.includes('crunchbase.com') && 
                (fullUrl.includes('/person/') || fullUrl.includes('/people/') || fullUrl.includes('/investor'))) {
                investorLinks.push(fullUrl);
            }
        }
    });
    
    $('[class*="profile"], [class*="card"], [class*="result"]').each((i, el) => {
        const $el = $(el);
        const link = $el.find('a[href*="/person/"], a[href*="/people/"]').first().attr('href');
        if (link) {
            const fullUrl = link.startsWith('http') ? link : new URL(link, url).href;
            if (fullUrl.includes('crunchbase.com') && 
                (fullUrl.includes('/person/') || fullUrl.includes('/people/'))) {
                investorLinks.push(fullUrl);
            }
        }
    });
    
    log.info(`Found ${investorLinks.length} investor profile links on page`, { url });
    
    return [...new Set(investorLinks)];
};

const extractNumericValue = (text) => {
    if (!text) return null;
    const cleaned = text.replace(/[$,€£¥,\s]/g, '');
    const match = cleaned.match(/(\d+(?:\.\d+)?)/);
    if (match) {
        const num = parseFloat(match[1]);
        if (text.toLowerCase().includes('b') || text.toLowerCase().includes('billion')) {
            return num * 1000000000;
        }
        if (text.toLowerCase().includes('m') || text.toLowerCase().includes('million')) {
            return num * 1000000;
        }
        if (text.toLowerCase().includes('k') || text.toLowerCase().includes('thousand')) {
            return num * 1000;
        }
        return num;
    }
    return null;
};


const extractInvestorData = ($, url, log, extractMA = true) => {
    const data = {
        url,
        source: 'crunchbase',
        entityType: 'investor',
        investorName: '',
        title: '',
        company: '',
        location: '',
        description: '',
        investmentFocus: '',
        portfolioSize: '',
        socialLinks: {},
        investmentCriteria: '',
        preferredIndustries: [],
        dealReadiness: '',
    };

    data.investorName = $('h1[class*="profile-name"], h1[class*="name"], .profile-name').first().text().trim() ||
                      $('h1').first().text().trim() ||
                      $('title').text().split('|')[0].trim();

    data.title = $('[class*="title"], [class*="role"], .profile-title').first().text().trim() || '';

    data.company = $('[class*="organization"], [class*="firm"]').first().text().trim() || '';

    data.location = $('[class*="location"], [class*="headquarters"]').first().text().trim() || '';

    data.description = $('[class*="description"], [class*="about"]').first().text().trim() ||
                      $('meta[name="description"]').attr('content') || '';

    data.investmentFocus = $('[class*="focus"], [class*="investment-focus"]').first().text().trim() || '';

    data.portfolioSize = $('text:contains("Portfolio"), text:contains("Investments")').parent().text().trim() || '';

    if (extractMA) {
        data.investmentCriteria = $('[class*="criteria"], [class*="preferences"]').first().text().trim() || '';

        $('[class*="industry"], [class*="sector"]').each((i, el) => {
            const industry = $(el).text().trim();
            if (industry) data.preferredIndustries.push(industry);
        });

        let readinessScore = 0;
        if (data.investorName) readinessScore += 1;
        if (data.company) readinessScore += 1;
        if (data.investmentFocus) readinessScore += 2;
        if (data.portfolioSize) readinessScore += 1;
        if (data.preferredIndustries.length > 0) readinessScore += 1;
        
        if (readinessScore >= 5) data.dealReadiness = 'High';
        else if (readinessScore >= 3) data.dealReadiness = 'Medium';
        else data.dealReadiness = 'Low';
    }

    $('a[href*="linkedin.com"], a[href*="twitter.com"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href) {
            if (href.includes('linkedin.com')) data.socialLinks.linkedin = href;
            if (href.includes('twitter.com') || href.includes('x.com')) data.socialLinks.twitter = href;
        }
    });

    log.info(`Extracted investor data for: ${data.investorName}`, { url });

    return data;
};

const extractLinkedInUrl = ($, url, log) => {
    let linkedInUrl = null;
    
    $('a[href*="linkedin.com"]').each((i, el) => {
        const href = $(el).attr('href');
        if (href && (href.includes('/in/') || href.includes('/profile/'))) {
            if (href.startsWith('http')) {
                const urlObj = new URL(href);
                if (urlObj.pathname.includes('/in/') || urlObj.pathname.includes('/profile/')) {
                    linkedInUrl = `https://www.linkedin.com${urlObj.pathname}`;
                    return false;
                }
                linkedInUrl = href.split('?')[0];
                return false;
            } else {
                const fullUrl = new URL(href, url).href;
                const urlObj = new URL(fullUrl);
                if (urlObj.pathname.includes('/in/') || urlObj.pathname.includes('/profile/')) {
                    linkedInUrl = `https://www.linkedin.com${urlObj.pathname}`;
                    return false;
                }
            }
        }
    });
    
    if (linkedInUrl) {
        log.info(`Found LinkedIn profile: ${linkedInUrl}`, { url });
    } else {
        log.warning(`No LinkedIn profile found on Crunchbase page`, { url });
    }
    
    return linkedInUrl;
};

const extractLinkedInData = ($, url, log, extractMA = true) => {
    const data = {
        url,
        source: 'linkedin',
        entityType: 'investor-profile',
        fullName: '',
        headline: '',
        location: '',
        currentCompany: '',
        currentPosition: '',
        about: '',
        experience: [],
        education: [],
        skills: [],
        connections: '',
        investmentFocus: '',
        dealReadiness: '',
    };

    data.fullName = $('h1[class*="text-heading"], h1[class*="name"], .pv-text-details__left-panel h1').first().text().trim() ||
                   $('h1').first().text().trim() ||
                   $('title').text().split('|')[0].trim();

    data.headline = $('[class*="headline"], [class*="text-body-medium"], .pv-text-details__left-panel .text-body-medium').first().text().trim() ||
                   $('h2[class*="headline"]').first().text().trim() || '';

    data.location = $('[class*="location"], [class*="text-body-small"], .pv-text-details__left-panel .text-body-small').first().text().trim() ||
                   $('span[class*="location"]').first().text().trim() || '';

    if (data.headline) {
        const headlineParts = data.headline.split(' at ');
        if (headlineParts.length > 1) {
            data.currentPosition = headlineParts[0].trim();
            data.currentCompany = headlineParts[1].trim();
        } else {
            data.currentPosition = data.headline;
        }
    }

    data.about = $('[class*="about"], [class*="summary"], #about, .pv-about-section').first().text().trim() ||
                $('section[aria-labelledby*="about"]').first().text().trim() || '';

    $('[class*="experience"], [class*="position"], .pvs-list__item').each((i, el) => {
        const $exp = $(el);
        const title = $exp.find('[class*="title"], h3, h4').first().text().trim();
        const company = $exp.find('[class*="company"], [class*="entity"]').first().text().trim();
        if (title || company) {
            data.experience.push({
                title: title || '',
                company: company || '',
            });
        }
    });

    $('[class*="education"], [class*="school"]').each((i, el) => {
        const $edu = $(el);
        const school = $edu.find('[class*="school"], h3, h4').first().text().trim();
        const degree = $edu.find('[class*="degree"]').first().text().trim();
        if (school) {
            data.education.push({
                school: school || '',
                degree: degree || '',
            });
        }
    });

    $('[class*="skill"], [class*="endorsement"]').each((i, el) => {
        const skill = $(el).text().trim();
        if (skill && skill.length < 50) {
            data.skills.push(skill);
        }
    });

    data.connections = $('span[class*="connections"], [class*="connection"]').first().text().trim() || '';

    if (extractMA) {
        const aboutLower = (data.about + ' ' + data.headline).toLowerCase();
        if (aboutLower.includes('investor') || aboutLower.includes('venture') || aboutLower.includes('angel')) {
            data.investmentFocus = 'Angel/VC Investor';
        } else if (aboutLower.includes('startup') || aboutLower.includes('founder')) {
            data.investmentFocus = 'Startup Ecosystem';
        }

        let readinessScore = 0;
        if (data.fullName) readinessScore += 1;
        if (data.headline && (data.headline.toLowerCase().includes('investor') || data.headline.toLowerCase().includes('angel'))) readinessScore += 2;
        if (data.currentCompany) readinessScore += 1;
        if (data.about) readinessScore += 1;
        if (data.experience.length > 0) readinessScore += 1;

        if (readinessScore >= 5) data.dealReadiness = 'High';
        else if (readinessScore >= 3) data.dealReadiness = 'Medium';
        else data.dealReadiness = 'Low';
    }

    log.info(`Extracted LinkedIn profile data for: ${data.fullName}`, { url });

    return data;
};


const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ enqueueLinks, request, $, log }) {
        const url = request.loadedUrl;
        const detectedType = detectUrlType(url);
        
        if (!url.includes('crunchbase.com') && !url.includes('linkedin.com')) {
            log.warning(`Skipping non-Crunchbase/LinkedIn URL: ${url}`);
            return;
        }
        
        let mode = scrapingMode;
        if (mode === 'auto') {
            mode = detectedType;
        }

        if (url.includes('linkedin.com')) {
            log.info('Scraping LinkedIn profile', { url });
            const extractedData = extractLinkedInData($, url, log, extractMAData);
            
            if (extractedData && extractedData.fullName) {
                await Dataset.pushData(extractedData);
                log.info(`Saved LinkedIn profile for: ${extractedData.fullName}`, { url });
            }
            return;
        }

        if (discoverInvestors && (detectedType === 'investor-search' || 
            (url.includes('crunchbase.com') && (url.includes('/search/') || url.includes('/discover/') || url.includes('/people'))))) {
            log.info('Discovering investors from search/listing page', { url });
            const investorLinks = extractInvestorLinks($, url, log);
            
            if (investorLinks.length > 0) {
                const requestQueue = await RequestQueue.open();
                for (const investorUrl of investorLinks) {
                    if (investorUrl.includes('crunchbase.com')) {
                        await requestQueue.addRequest({ url: investorUrl });
                    }
                }
                log.info(`Enqueued ${investorLinks.filter(u => u.includes('crunchbase.com')).length} Crunchbase investor profiles for scraping`, { url });
            }
            
            return;
        }

        if (url.includes('crunchbase.com') && (detectedType === 'investor' || mode === 'investor' || 
            url.includes('/person/') || url.includes('/people/') || url.includes('/investor'))) {
            log.info('Processing Crunchbase investor profile', { url });
            
            const crunchbaseData = extractInvestorData($, url, log, extractMAData);
            
            const linkedInUrl = extractLinkedInUrl($, url, log);
            
            if (linkedInUrl) {
                crunchbaseData.linkedInProfileUrl = linkedInUrl;
                
                const requestQueue = await RequestQueue.open();
                await requestQueue.addRequest({ url: linkedInUrl });
                log.info(`Enqueued LinkedIn profile for scraping: ${linkedInUrl}`, { url });
            }
            
            if (crunchbaseData && crunchbaseData.investorName) {
                await Dataset.pushData(crunchbaseData);
                log.info(`Saved Crunchbase investor data for: ${crunchbaseData.investorName}`, { url });
            }
            
            return;
        }

        log.warning(`Skipping non-investor Crunchbase page: ${url}`);
    },
});

await crawler.run(startUrls);

await Actor.exit();

