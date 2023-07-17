import {BrowserWindow, Tool} from 'chie';
import {JSDOM} from 'jsdom';
import {Readability} from '@mozilla/readability';

export default {
  name: 'browse',
  displayName: 'Browse',
  descriptionForModel: 'Read content of URL from Internet.',

  parameters: [
    {
      name: 'url',
      description: 'The URL of web page',
      type: 'string' as const,
    },
  ],

  async execute(signal, {url}) {
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
        resultForModel: article?.textContent.trim().substring(0, 3000) ?? '(no content)',
        resultForHuman: article?.title ?? '(no title)',
      };
    } finally {
      win.close();
    }
  }
}
