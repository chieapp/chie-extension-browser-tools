import google from 'googlethis';
import Tool from './tool';

export default class ToolSearch implements Tool {
  name = 'search';
  displayName = 'Search';
  descriptionForModel = `\
A search engine to query information from internet. Input is any text search \
query. Output are urls and their titles.`

  async execute(query: string) {
    const response = await google.search(query, {page: 0});
    return {
      resultForModel: response.results.map(r => `${r.title}\n${r.url}\n`).join('\n'),
      resultForHuman: `${response.results.length} results`,
    };
  }
}
