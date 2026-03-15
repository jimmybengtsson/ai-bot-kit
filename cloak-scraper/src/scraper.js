import { launch } from "cloakbrowser";
import { config } from "./config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeLaunchOptions = () => {
  const options = {
    headless: config.headless,
    humanize: config.humanize,
    humanPreset: config.humanPreset
  };

  if (config.proxy) {
    options.proxy = config.proxy;
  }

  if (config.locale) {
    options.locale = config.locale;
  }

  if (config.timezone) {
    options.timezone = config.timezone;
  }

  if (config.geoip) {
    options.geoip = true;
  }

  if (config.extraArgs.length) {
    options.args = config.extraArgs;
  }

  return options;
};

export const withCloakPage = async (runner) => {
  const browser = await launch(makeLaunchOptions());

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    page.setDefaultTimeout(config.navigationTimeoutMs);

    return await runner(page, sleep);
  } finally {
    await browser.close();
  }
};
