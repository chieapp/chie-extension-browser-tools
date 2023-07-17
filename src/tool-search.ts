import google from 'googlethis';
import {Tool} from 'chie';

export default {
  name: 'search',
  displayName: 'Search',
  descriptionForModel: 'A search engine to query information from Internet.',

  parameters: [
    {
      name: 'query',
      description: 'The query text to search from Internet',
      type: 'string' as const,
    },
  ],

  async execute(signal, {query}) {
    const response = await google.search(query, {page: 0});
    return {
      resultForModel: response.results.map(r => `${r.title}\n${r.url}\n`).join('\n'),
      resultForHuman: `${response.results.length} results`,
    };
  },
}
