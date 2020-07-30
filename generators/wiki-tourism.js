const wtf = require('wtf_wikipedia');
const _ = require('lodash');
const Bluebird = require('bluebird');
const { promises: fs } = require('fs');
const wiki = require('wikijs').default;
const crg = require('country-reverse-geocoding').country_reverse_geocoding();
const countryinfo = require('countryinfo');

const wikiFetcher = wiki({
  headers: {
    'Api-User-Agent': 'blackmad@radar.io',
    'User-Agent': 'blackmad@radar.io',
  },
});

async function fetchDoc(id) {
  const doc = await wtf.fetch(id, 'en', {
    'Api-User-Agent': 'blackmad@radar.io',
  });
  if (!doc) {
    console.error('could not fetch', id);
    return {};
  }
  return doc;
}

async function extractCoords({doc, id}) {
  if (doc.coordinates && doc.coordinates().length > 0 && doc.coordinates()[0].lat) {
    // console.log('returning doc coords', doc.coordinates());
    return doc.coordinates()[0];
  }

  // if we can't get coordinates from wtf for some reason, try from wikijs 
  // (if we were capable of fetching a doc at all - that's the doc.sections check)
  if (!doc.sections) {
    // console.log('returning, no sections')
    return;
  }
  const w = await wikiFetcher.page(id);
  try {
    const parsedCoords = await w.coordinates();
    if (parsedCoords && parsedCoords.lat) {
      // console.log('returning parsedCoords', parsedCoords);
      return parsedCoords;
    }
  } catch {

  }

  // This is very slow so not worth it
  //
  // const cheerio = require('cheerio')
  // const CoordinateParser = require('coordinate-parser');
  //
  // try our own parses from the html
  // const parsedHtml = cheerio.load(await w.html());
  // const htmlLat = parsedHtml('.latitude').first().text();
  // const htmlLon = parsedHtml('.longitude').first().text();
  // console.log('trying to find html coords')
  // if (htmlLat && htmlLon) {
  //   console.log('returning html coords', htmlLat, htmlLon)
  //   const coords = new CoordinateParser(`${htmlLat} ${htmlLon}`);
  //   return {
  //     lat: coords.getLatitude(),
  //     lon: coords.getLongitude(),
  //   };
  // }
}

async function getOtherNames({ id, lat, lon }) {
  const country = crg.get_country(lat, lon);
  if (!country) {
    return [];
  }

  let countryLangs = [];
  try {
    countryLangs = countryinfo.languages(country.code) || [];
  } catch {

  }

  const lang2codes = [countryLangs.map((l) => l.alpha2), 'en'];

  const w = await wikiFetcher.page(id);
  if (!w) {
    return [];
  }
  try {
    const langlinks = await w.langlinks();

    // filter down the langlinks to just the languages spoken in the country of the poi + english
    const filteredLinks = _.uniq(
      langlinks.filter((ll) => lang2codes.includes(ll.lang)).map((ll) => ll.title)
    );
    return filteredLinks;
  } catch {
    return [];
  }
}

async function fetchPlace(id) {
  const doc = await fetchDoc(id);

  function findGeoName(level) {
    return doc
      .infoboxes()
      .map((infobox) => {
        const subdivision_key = _.findKey(infobox, (value, key) => {
          return (
            key.includes('subdivision_type') &&
            value.text &&
            value.text.trim().toLowerCase() === level.toLowerCase()
          );
        });

        if (subdivision_key) {
          return infobox[subdivision_key.replace('type', 'name')].text.trim();
        }
      })
      .filter((x) => !!x)[0];
  }

  const coords = await extractCoords({doc, id});
  if (!coords) {
    console.error('no coordinates for', id);
    return [];
  }

  const { lat, lon } = coords;
  if (!lat || !lon) {
    console.log('weird coords', coords);
    return [];
  }

  // In case the page uses disambiguation, like Adventure Island (water park), remove the part in parens
  const hackedName = id.replace(/ \(.*\)/, '');

  const allNames = _.uniq([...(await getOtherNames({ id, lat, lon })), hackedName]);

  return allNames.map((name) => {
    // At least one artile likes en-dashes, but pelias only understands basic hyphens
    const normalizedName = name.replace('–', '-');

    return {
      id,
      status: 'pass',
      type: 'wiki-poi',
      in: {
        text: normalizedName,
      },
      expected: {
        coordinates: [lon, lat],
        distanceThresh: 5000,
        properties: {
          region: findGeoName('State'),
          locality: findGeoName('City'),
          layer: 'venue',
          name: normalizedName,
        },
      },
    };
  });
}

async function fetchPagesHelper({ pageName, links }) {
  links = _.uniq(links);
  // console.error(links);
  console.error(`${pageName}: ${links.length} links extracted`);

  const tests = (await Bluebird.map(links, fetchPlace, { concurrency: 10 })).flatMap((x) => x);

  return {
    name: `wikipedia scrape: ${pageName}`,
    description: '',
    priorityThresh: '',
    source: 'Wikipedia',
    normalizers: {
      name: ['toLowerCase', 'removeOrdinals', 'stripPunctuation', 'abbreviateDirectionals'],
    },
    tests,
  };
}

function findLinksInTemplates({ doc, keys }) {
  const links = doc
    .json()
    .sections.flatMap((section) => {
      return (section.templates || []).flatMap((template) => {
        return keys.map((key) => template[key.toLowerCase()]);
      });
    })
    .filter((p) => !!p);

  return links;
}

function findLinksInTables({ doc, keys }) {
  return doc
    .json()
    .sections.flatMap((section) => {
      return (section.tables || []).flatMap((table) => {
        return table.flatMap((row) => {
          return keys.map((key) => {
            return row[key];
          });
        });
      });
    })
    .filter((p) => !!p)
    .flatMap((p) => (p.links ? [p.links[0].page] : []));
}

async function fetchPageWithTables({ pageName, keys }) {
  const doc = await wtf.fetch(pageName);

  let links = findLinksInTables({ doc, keys });

  if (links.length === 0) {
    // Sometimes what looks like tables in wikipedia are actually 'templates'
    links = findLinksInTemplates({ doc, keys });
  }

  if (links.length === 0) {
    // now try with wikijs which sometimes is better at parsing tables but worse about giving
    // us the exact links we need

    const w = await wikiFetcher.page(pageName);
    if (w) {
      console.error('no places with wtf_wikipedia, trying wikijs');
      links = (await w.tables()).flatMap((table) => {
        return table.flatMap((row) => {
          return keys.flatMap((tableKey) => {
            const value = row[tableKey.toLowerCase()];
            return value ? [value] : [];
          });
        });
      });
    }
  }

  return fetchPagesHelper({ pageName, links });
}

async function fetchAndWritePageWithTables({ pageName, keys }) {
  const data = await fetchPageWithTables({ pageName, keys });
  await fs.writeFile(`test_cases/${pageName}.json`, JSON.stringify(data, null, 2));
}

async function doFetches() {
  await fetchAndWritePageWithTables({
    pageName: 'Tourist_attractions_in_the_United_States',
    keys: ['Place'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_amusement_park_rankings',
    keys: ['Amusement park', 'Water park'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_largest_art_museums',
    keys: ['Name'],
  });
  // Sadly this page is broken - neither wtf nor wikijs can parse the table
  // await fetchAndWritePageWithTables({
  //   pageName: 'List_of_urban_parks_by_size',
  //   keys: ['Name'],
  // });

  // Zoos, and, I love this word 'Aquaria'
  await fetchAndWritePageWithTables({
    pageName: 'List_of_AZA_member_zoos_and_aquaria',
    keys: ['Name'],
  });

  // Stadiums
  await fetchAndWritePageWithTables({
    pageName: 'List_of_U.S._stadiums_by_capacity',
    keys: ['Stadium'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_association_football_stadiums_by_capacity',
    keys: ['Stadium'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_stadiums_by_capacity',
    keys: ['Stadium'],
  });


  // UNESCO world heritage sites
  await fetchAndWritePageWithTables({
    pageName: 'List_of_World_Heritage_Sites_in_Northern_Europe',
    keys: ['name'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_World_Heritage_Sites_in_Eastern_Europe',
    keys: ['name'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_World_Heritage_Sites_in_Western_Europe',
    keys: ['name'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_World_Heritage_Sites_in_Southern_Europe',
    keys: ['name'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_World_Heritage_Sites_in_North_America',
    keys: ['name'],
  });
  await fetchAndWritePageWithTables({
    pageName: 'List_of_World_Heritage_Sites_in_Africa',
    keys: ['name'],
  });
}

doFetches();