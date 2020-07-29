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

async function getOtherNames({ id, lat, lon }) {
  const country = crg.get_country(lat, lon);
  if (!country) {
    return [];
  }

  const lang2codes = [...(countryinfo.languages(country.code) || []).map((l) => l.alpha2), 'en'];

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

  if (!doc.coordinates) {
    return [];
  }

  const coords = doc.coordinates();

  if ((coords || []).length > 0) {
    const { lat, lon } = coords[0];

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
  } else {
    console.error('no coordinates for', id);
  }

  return [];
}

async function fetchPageWithTables({ pageName, tableKeys }) {
  const doc = await wtf.fetch(pageName);

  const places = doc
    .json()
    .sections.flatMap((section) => {
      return (section.tables || []).flatMap((table) => {
        return table.flatMap((row) => {
          return tableKeys.map((tableKey) => {
            return row[tableKey];
          });
        });
      });
    })
    .filter((p) => !!p);

  let links = _.uniq(places.flatMap((p) => (p.links ? [p.links[0].page] : [])));

  if (links.length === 0) {
    // now try with wikijs which sometimes is better at parsing tables but worse about giving
    // us the exact links we need

    const w = await wikiFetcher.page(pageName);
    if (w) {
      console.error('no places with wtf_wikipedia, trying wikijs');
      links = (await w.tables()).flatMap((table) => {
        return table.flatMap((row) => {
          return tableKeys.flatMap((tableKey) => {
            const value = row[tableKey.toLowerCase()];
            return value ? [value] : [];
          });
        });
      });
    }
  }

  console.error(links);
  console.error(links.length);

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

async function fetchAndWritePageWithTables({ pageName, tableKeys }) {
  const data = await fetchPageWithTables({ pageName, tableKeys });
  await fs.writeFile(`test_cases/${pageName}.json`, JSON.stringify(data, null, 2));
}

fetchAndWritePageWithTables({
  pageName: 'Tourist_attractions_in_the_United_States',
  tableKeys: ['Place'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_amusement_park_rankings',
  tableKeys: ['Amusement park', 'Water park'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_largest_art_museums',
  tableKeys: ['Name'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_urban_parks_by_size',
  tableKeys: ['Name'],
});

// Zoos, and, I love this word 'Aquaria'
fetchAndWritePageWithTables({
  pageName: 'List_of_AZA_member_zoos_and_aquaria',
  tableKeys: ['Name'],
});

// Stadiums
fetchAndWritePageWithTables({
  pageName: 'List_of_U.S._stadiums_by_capacity',
  tableKeys: ['Stadium'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_association_football_stadiums_by_capacity',
  tableKeys: ['Stadium'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_stadiums_by_capacity',
  tableKeys: ['Stadium'],
});

// UNESCO world heritage sites
fetchAndWritePageWithTables({
  pageName: 'List_of_World_Heritage_Sites_in_Northern_Europe',
  tableKeys: ['Name'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_World_Heritage_Sites_in_Eastern_Europe',
  tableKeys: ['Name'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_World_Heritage_Sites_in_Western_Europe',
  tableKeys: ['Name'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_World_Heritage_Sites_in_Southern_Europe',
  tableKeys: ['Name'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_World_Heritage_Sites_in_North_America',
  tableKeys: ['Name'],
});
fetchAndWritePageWithTables({
  pageName: 'List_of_World_Heritage_Sites_in_Africa',
  tableKeys: ['Name'],
});
