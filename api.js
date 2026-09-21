'use strict';

module.exports = {
  async collectHs220Diagnostics({ homey }) {
    return homey.app.collectHs220Diagnostics();
  },

  async testCredentials({ homey, body }) {
    return homey.app.testGlobalCredentials(body || {});
  },

  async getCredentialStatus({ homey }) {
    return homey.app.getCredentialStatus();
  },

  async saveCredentials({ homey, body }) {
    return homey.app.saveGlobalCredentials(body || {});
  },

  async clearCredentials({ homey }) {
    return homey.app.clearGlobalCredentials();
  },

  async adoptLegacyCredentials({ homey }) {
    return homey.app.adoptMatchingLegacyDevices();
  },
};
