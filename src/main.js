// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset, RequestQueue } from 'crawlee';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init()
await Actor.init();

// Structure of input is defined in input_schema.json
const { 
    startUrls = ['https://apify.com'], 
    scrapingMode = 'auto',
    extractMAData = true,
    discoverInvestors = false,
    maxRequestsPerCrawl = 100 
} = (await Actor.getInput()) ?? {};

// Proxy configuration to rotate IP addresses and prevent blocking (https://docs.apify.com/platform/proxy)
// Use residential proxies for better anti-bot evasion (requires Apify account with proxy access)
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'], // Use residential proxies for better stealth (fallback to datacenter if not available)
});

// Helper function to detect URL type
const detectUrlType = (url) => {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.toLowerCase();
        const pathname = urlObj.pathname.toLowerCase();
        
        if (hostname.includes('crunchbase.com')) {
            if (pathname.includes('/person/') || pathname.includes('/investor') || pathname.includes('/people/')) {
                return 'investor';
            }
            if (pathname.includes('/search/') || pathname.includes('/discover/') || 
                pathname.includes('/people') || pathname.includes('/person')) {
                return 'investor-search'; // Search/listing page
            }
            return 'crunchbase';
        }
        if (hostname.includes('bizbuysell.com') || hostname.includes('businessesforsale') || 
            hostname.includes('flippa.com') || hostname.includes('empireflippers')) {
            return 'business-listing';
        }
        return 'general';
    } catch {
        return 'general';
    }
};

// Helper function to extract investor profile links from Crunchbase search/listing pages
const extractInvestorLinks = ($, url, log) => {
    const investorLinks = [];
    try {
        // Look for links to investor profiles
        $('a[href*="/person/"], a[href*="/people/"], a[href*="/investor"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                try {
                    const fullUrl = href.startsWith('http') ? href : new URL(href, url).href;
                    if (fullUrl.includes('crunchbase.com') && 
                        (fullUrl.includes('/person/') || fullUrl.includes('/people/') || fullUrl.includes('/investor'))) {
                        investorLinks.push(fullUrl);
                    }
                } catch (e) {
                    // Skip invalid URLs
                }
            }
        });
        
        // Also look for profile cards or listings
        $('[class*="profile"], [class*="card"], [class*="result"]').each((i, el) => {
            const $el = $(el);
            const link = $el.find('a[href*="/person/"], a[href*="/people/"]').first().attr('href');
            if (link) {
                try {
                    const fullUrl = link.startsWith('http') ? link : new URL(link, url).href;
                    if (fullUrl.includes('crunchbase.com') && 
                        (fullUrl.includes('/person/') || fullUrl.includes('/people/'))) {
                        investorLinks.push(fullUrl);
                    }
                } catch (e) {
                    // Skip invalid URLs
                }
            }
        });
        
        log.info(`Found ${investorLinks.length} investor profile links on page`, { url });
    } catch (error) {
        log.error(`Error extracting investor links: ${error.message}`, { url });
    }
    
    return [...new Set(investorLinks)]; // Remove duplicates
};

// Helper function to extract numeric value from text (for revenue, valuation, etc.)
const extractNumericValue = (text) => {
    if (!text) return null;
    // Remove common currency symbols and extract numbers
    const cleaned = text.replace(/[$,€£¥,\s]/g, '');
    const match = cleaned.match(/(\d+(?:\.\d+)?)/);
    if (match) {
        const num = parseFloat(match[1]);
        // Handle K, M, B suffixes
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

// Helper function to extract Crunchbase company data with M&A enhancements
const extractCrunchbaseData = ($, url, log, extractMA = true) => {
    const data = {
        url,
        source: 'crunchbase',
        entityType: 'company',
        companyName: '',
        description: '',
        website: '',
        founded: '',
        employees: '',
        location: '',
        industry: '',
        funding: '',
        totalFunding: '',
        lastFundingDate: '',
        socialLinks: {},
        // M&A specific fields
        revenue: null,
        revenueText: '',
        valuation: null,
        valuationText: '',
        businessType: '',
        dealReadiness: '',
        matchingScore: null,
    };

    try {
        // Extract company name
        data.companyName = $('h1[class*="profile-name"], h1[class*="name"], .profile-name, .profile-header-name').first().text().trim() ||
                          $('h1').first().text().trim() ||
                          $('title').text().split('|')[0].trim();

        // Extract description
        data.description = $('[class*="description"], [class*="about"], .profile-section-description').first().text().trim() ||
                          $('meta[name="description"]').attr('content') || '';

        // Extract website
        data.website = $('a[class*="website"], a[href^="http"]:contains("Website")').first().attr('href') ||
                      $('a[rel="noopener"][target="_blank"]').filter((i, el) => {
                          const href = $(el).attr('href');
                          return href && !href.includes('crunchbase.com') && href.startsWith('http');
                      }).first().attr('href') || '';

        // Extract founded year
        const foundedText = $('[class*="founded"], [class*="founding"], .founded-date').first().text().trim() ||
                           $('text:contains("Founded")').parent().text().replace('Founded', '').trim() || '';
        data.founded = foundedText;
        
        // Extract employees
        const employeesText = $('[class*="employees"], [class*="employee-count"], .employee-count').first().text().trim() ||
                             $('text:contains("Employees")').parent().text().replace('Employees', '').trim() || '';
        data.employees = employeesText;

        // Extract location
        data.location = $('[class*="location"], [class*="headquarters"], .location').first().text().trim() ||
                       $('text:contains("Headquarters")').parent().text().replace('Headquarters', '').trim() || '';

        // Extract industry
        data.industry = $('[class*="industry"], [class*="category"], .industry').first().text().trim() ||
                       $('text:contains("Industry")').parent().text().replace('Industry', '').trim() || '';

        // Extract funding information
        const fundingText = $('[class*="funding"], [class*="total-funding"], .total-funding').first().text().trim() ||
                           $('text:contains("Total Funding")').parent().text().replace('Total Funding', '').trim() || '';
        data.funding = fundingText;
        data.totalFunding = fundingText;
        
        // Extract valuation from funding (M&A relevant)
        if (extractMA && fundingText) {
            data.valuationText = fundingText;
            data.valuation = extractNumericValue(fundingText);
        }

        // Extract last funding date
        data.lastFundingDate = $('[class*="last-funding"], [class*="funding-date"], .last-funding-date').first().text().trim() ||
                               $('text:contains("Last Funding")').parent().text().replace('Last Funding', '').trim() || '';

        // M&A specific extractions
        if (extractMA) {
            // Try to extract revenue information
            const revenueText = $('text:contains("Revenue"), text:contains("Annual Revenue")').parent().text() ||
                               $('[class*="revenue"]').first().text().trim() || '';
            if (revenueText) {
                data.revenueText = revenueText;
                data.revenue = extractNumericValue(revenueText);
            }

            // Determine business type from industry/description
            const industryLower = data.industry.toLowerCase();
            if (industryLower.includes('saas') || industryLower.includes('software')) {
                data.businessType = 'SaaS';
            } else if (industryLower.includes('ecommerce') || industryLower.includes('retail')) {
                data.businessType = 'E-commerce';
            } else if (industryLower.includes('service')) {
                data.businessType = 'Service Business';
            } else if (industryLower.includes('manufacturing')) {
                data.businessType = 'Manufacturing';
            } else {
                data.businessType = data.industry || 'Other';
            }

            // Assess deal readiness based on available data
            let readinessScore = 0;
            if (data.companyName) readinessScore += 1;
            if (data.description) readinessScore += 1;
            if (data.website) readinessScore += 1;
            if (data.revenue || data.valuation) readinessScore += 2;
            if (data.employees) readinessScore += 1;
            if (data.location) readinessScore += 1;
            
            if (readinessScore >= 5) data.dealReadiness = 'High';
            else if (readinessScore >= 3) data.dealReadiness = 'Medium';
            else data.dealReadiness = 'Low';
            
            data.matchingScore = readinessScore;
        }

        // Extract social links
        $('a[href*="linkedin.com"], a[href*="twitter.com"], a[href*="facebook.com"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                if (href.includes('linkedin.com')) data.socialLinks.linkedin = href;
                if (href.includes('twitter.com') || href.includes('x.com')) data.socialLinks.twitter = href;
                if (href.includes('facebook.com')) data.socialLinks.facebook = href;
            }
        });

        log.info(`Extracted Crunchbase data for: ${data.companyName}`, { url });
    } catch (error) {
        log.error(`Error extracting Crunchbase data: ${error.message}`, { url });
    }

    return data;
};

// Helper function to extract investor data
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
        // M&A specific
        investmentCriteria: '',
        preferredIndustries: [],
        dealReadiness: '',
    };

    try {
        // Extract investor name
        data.investorName = $('h1[class*="profile-name"], h1[class*="name"], .profile-name').first().text().trim() ||
                          $('h1').first().text().trim() ||
                          $('title').text().split('|')[0].trim();

        // Extract title/role
        data.title = $('[class*="title"], [class*="role"], .profile-title').first().text().trim() || '';

        // Extract company/organization
        data.company = $('[class*="organization"], [class*="firm"]').first().text().trim() || '';

        // Extract location
        data.location = $('[class*="location"], [class*="headquarters"]').first().text().trim() || '';

        // Extract description
        data.description = $('[class*="description"], [class*="about"]').first().text().trim() ||
                          $('meta[name="description"]').attr('content') || '';

        // Extract investment focus
        data.investmentFocus = $('[class*="focus"], [class*="investment-focus"]').first().text().trim() || '';

        // Extract portfolio size
        data.portfolioSize = $('text:contains("Portfolio"), text:contains("Investments")').parent().text().trim() || '';

        if (extractMA) {
            // Extract investment criteria
            data.investmentCriteria = $('[class*="criteria"], [class*="preferences"]').first().text().trim() || '';

            // Extract preferred industries
            $('[class*="industry"], [class*="sector"]').each((i, el) => {
                const industry = $(el).text().trim();
                if (industry) data.preferredIndustries.push(industry);
            });

            // Assess deal readiness for investors
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

        // Extract social links
        $('a[href*="linkedin.com"], a[href*="twitter.com"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                if (href.includes('linkedin.com')) data.socialLinks.linkedin = href;
                if (href.includes('twitter.com') || href.includes('x.com')) data.socialLinks.twitter = href;
            }
        });

        log.info(`Extracted investor data for: ${data.investorName}`, { url });
    } catch (error) {
        log.error(`Error extracting investor data: ${error.message}`, { url });
    }

    return data;
};

// Helper function to extract business listing data (for M&A marketplaces)
const extractBusinessListingData = ($, url, log, extractMA = true) => {
    const data = {
        url,
        source: 'business-listing',
        entityType: 'business-for-sale',
        businessName: '',
        askingPrice: null,
        askingPriceText: '',
        revenue: null,
        revenueText: '',
        cashFlow: null,
        cashFlowText: '',
        location: '',
        industry: '',
        businessType: '',
        description: '',
        established: '',
        employees: '',
        dealReadiness: 'High', // Listings are typically ready
        matchingScore: 10,
    };

    try {
        // Extract business name
        data.businessName = $('h1[class*="title"], h1[class*="name"], .listing-title').first().text().trim() ||
                           $('h1').first().text().trim() ||
                           $('title').text().split('|')[0].trim();

        // Extract asking price
        const priceText = $('[class*="price"], [class*="asking"], .price').first().text().trim() ||
                         $('text:contains("Asking Price"), text:contains("Price")').parent().text().trim() || '';
        if (priceText) {
            data.askingPriceText = priceText;
            data.askingPrice = extractNumericValue(priceText);
        }

        // Extract revenue
        const revenueText = $('[class*="revenue"], text:contains("Revenue")').parent().text().trim() || '';
        if (revenueText) {
            data.revenueText = revenueText;
            data.revenue = extractNumericValue(revenueText);
        }

        // Extract cash flow
        const cashFlowText = $('[class*="cash-flow"], text:contains("Cash Flow")').parent().text().trim() || '';
        if (cashFlowText) {
            data.cashFlowText = cashFlowText;
            data.cashFlow = extractNumericValue(cashFlowText);
        }

        // Extract location
        data.location = $('[class*="location"], [class*="address"]').first().text().trim() || '';

        // Extract industry
        data.industry = $('[class*="industry"], [class*="category"]').first().text().trim() || '';

        // Extract business type
        data.businessType = $('[class*="business-type"], [class*="type"]').first().text().trim() || '';

        // Extract description
        data.description = $('[class*="description"], [class*="details"]').first().text().trim() ||
                          $('meta[name="description"]').attr('content') || '';

        // Extract established year
        data.established = $('[class*="established"], [class*="founded"]').first().text().trim() || '';

        // Extract employees
        data.employees = $('[class*="employees"], text:contains("Employees")').parent().text().trim() || '';

        log.info(`Extracted business listing data for: ${data.businessName}`, { url });
    } catch (error) {
        log.error(`Error extracting business listing data: ${error.message}`, { url });
    }

    return data;
};

// Use CheerioCrawler - only for Crunchbase URLs
const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl,
    async requestHandler({ enqueueLinks, request, $, log }) {
        const url = request.loadedUrl;
        const detectedType = detectUrlType(url);
        
        // Only process Crunchbase URLs - skip everything else
        if (!url.includes('crunchbase.com')) {
            log.warning(`Skipping non-Crunchbase URL: ${url}`);
            return;
        }
        
        // Determine scraping mode
        let mode = scrapingMode;
        if (mode === 'auto') {
            mode = detectedType;
        }

        // Handle investor discovery mode
        if (discoverInvestors && (detectedType === 'investor-search' || 
            (url.includes('crunchbase.com') && (url.includes('/search/') || url.includes('/discover/') || url.includes('/people'))))) {
            log.info('Discovering investors from search/listing page', { url });
            const investorLinks = extractInvestorLinks($, url, log);
            
            // Enqueue all discovered investor profile links (only Crunchbase)
            if (investorLinks.length > 0) {
                const requestQueue = await RequestQueue.open();
                for (const investorUrl of investorLinks) {
                    if (investorUrl.includes('crunchbase.com')) {
                        await requestQueue.addRequest({ url: investorUrl });
                    }
                }
                log.info(`Enqueued ${investorLinks.filter(u => u.includes('crunchbase.com')).length} Crunchbase investor profiles for scraping`, { url });
            }
            
            return; // Don't extract data from the search page itself
        }

        log.info('enqueueing new URLs (Crunchbase only)');
        // Enqueue links - but only follow Crunchbase links
        await enqueueLinks({
            selector: 'a[href*="crunchbase.com"]',
        });

        let extractedData = null;

        // Extract data based on mode
        if (mode === 'crunchbase' || (mode === 'auto' && detectedType === 'crunchbase')) {
            // Check if it's an investor profile
            if (url.includes('/person/') || url.includes('/people/') || url.includes('/investor')) {
                extractedData = extractInvestorData($, url, log, extractMAData);
            } else {
                extractedData = extractCrunchbaseData($, url, log, extractMAData);
            }
        } else if (mode === 'investor' || (mode === 'auto' && detectedType === 'investor')) {
            extractedData = extractInvestorData($, url, log, extractMAData);
        } else if (mode === 'business-listing' || (mode === 'auto' && detectedType === 'business-listing')) {
            extractedData = extractBusinessListingData($, url, log, extractMAData);
        } else {
            // General scraping with enhanced M&A data extraction
            const title = $('title').text();
            extractedData = {
                url,
                title,
                source: 'general',
                entityType: 'page',
            };

            // Try to extract basic company info from general pages if M&A mode is enabled
            if (extractMAData) {
                // Look for common business indicators
                const bodyText = $('body').text().toLowerCase();
                const companyName = $('h1').first().text().trim() || title.split('|')[0].trim();
                
                extractedData.companyName = companyName;
                
                // Try to find revenue/valuation mentions
                const revenueMatch = bodyText.match(/(revenue|annual sales)[:\s]*\$?([\d,\.]+[kmb]?)/i);
                if (revenueMatch) {
                    extractedData.revenueText = revenueMatch[0];
                    extractedData.revenue = extractNumericValue(revenueMatch[0]);
                }

                // Try to find valuation mentions
                const valuationMatch = bodyText.match(/(valuation|worth|valued at)[:\s]*\$?([\d,\.]+[kmb]?)/i);
                if (valuationMatch) {
                    extractedData.valuationText = valuationMatch[0];
                    extractedData.valuation = extractNumericValue(valuationMatch[0]);
                }

                // Extract description
                extractedData.description = $('meta[name="description"]').attr('content') ||
                                          $('[class*="description"]').first().text().trim() || '';
            }

            log.info(`${title}`, { url });
        }

        // Save extracted data
        if (extractedData) {
            await Dataset.pushData(extractedData);
            const entityName = extractedData.companyName || 
                             extractedData.businessName || 
                             extractedData.investorName || 
                             extractedData.title || 
                             'Unknown';
            log.info(`Saved ${extractedData.entityType || 'data'} for: ${entityName}`, { url });
        }
    },
});

await crawler.run(startUrls);

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();

