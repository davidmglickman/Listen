const { existsSync } = require("node:fs");
const path = require("node:path");

const updateFeedUrl = process.env.LISTEN_UPDATE_FEED_URL?.trim();
const updateChannel = process.env.LISTEN_UPDATE_CHANNEL?.trim() || "latest";
const updateGithubOwner = process.env.LISTEN_UPDATE_GITHUB_OWNER?.trim();
const updateGithubRepo = process.env.LISTEN_UPDATE_GITHUB_REPO?.trim();
const updateGithubPrivate = process.env.LISTEN_UPDATE_GITHUB_PRIVATE === "true";
const iconPath = path.join(__dirname, "build", "icon.ico");

const config = {
  appId: "com.listen.desktop",
  productName: "Listen",
  electronVersion: "35.2.0",
  asar: true,
  directories: {
    output: "release",
  },
  files: [
    "dist/**/*",
    "package.json",
  ],
  win: {
    signAndEditExecutable: false,
    target: ["nsis"],
    artifactName: "Listen-${version}-Setup.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
};

if (existsSync(iconPath)) {
  config.win.icon = iconPath;
}

if (updateGithubOwner && updateGithubRepo) {
  config.publish = [
    {
      provider: "github",
      owner: updateGithubOwner,
      repo: updateGithubRepo,
      private: updateGithubPrivate,
      releaseType: updateChannel === "latest" ? "release" : "prerelease",
    },
  ];
} else if (updateFeedUrl) {
  config.publish = [
    {
      provider: "generic",
      url: updateFeedUrl,
      channel: updateChannel,
    },
  ];
}

module.exports = config;