import {BrowserWindow} from 'chie';
import {JSDOM} from 'jsdom';
import {Readability} from '@mozilla/readability';

import Tool from './tool';

export default class ToolBrowse implements Tool {
  name = 'browse';
  displayName = 'Browse';
  descriptionForModel = `\
Read content of URL from internet. Input is web page URL. Output is the text \
content of of the URL's page.`;

  async execute(url: string) {
    const win = new BrowserWindow();
    win.browser.loadURL(url);
    try {
      if (!win.browser.browser.isLoading())
        throw new Error('Invalid URL.');
      await win.waitForNavigation(/./);
      await new Promise(resolve => setTimeout(resolve, 2000));
      const text = await win.browser.executeJavaScript('document.documentElement.outerHTML');
      win.close();
      const dom = new JSDOM(text, {url});
      const reader = new Readability(dom.window.document);
      const article = reader.parse();
      return {
        resultForModel: article ? article.textContent.trim().substring(0, 3000) : 'Empty',
        resultForHuman: article ? article.title : 'Empty',
      };
    } finally {
      win.close();
    }
  }
}
