export default {
  regex:
    /^\[([0-9.:-]+)]\[([ 0-9]*)]LogEasyAntiCheatServer: \[[0-9:]+] \[[A-z]+] \[EAC Server] \[Info] \[RegisterClient] Client: ([A-z0-9]+) PlayerGUID: ([0-9]{17}) PlayerIP: [0-9]{17} OwnerGUID: [0-9]{17} PlayerName: (.+)/,
  onMatch: async (args, logParser) => {
    logParser.eventStore['steamid-connected'] = args[4];
  }
};
