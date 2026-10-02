function buildAgentContinuationProbeArgs(profilePath, probeEntry) {
  return [`--user-data-dir=${profilePath}`, probeEntry]
}

module.exports = { buildAgentContinuationProbeArgs }
