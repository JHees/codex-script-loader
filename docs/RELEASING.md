# Release notes

Every new release needs a reviewed `docs/RELEASE-<version>.md` in its tagged commit. Describe the user-visible outcome first, then group actual changes into relevant categories such as Fixed or Added. Include Chinese and English descriptions, upgrade or migration actions, compatibility changes and known limitations where applicable, and a comparison link to the previous tag.

Review the notes against that version's changes. The [GitHub CLI release pages](https://github.com/cli/cli/releases) demonstrate highlights, categorized changes and upgrade guidance; [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) explains why a release log should be curated for people rather than copied from Git history.

The Windows release workflow rejects missing or empty notes. It uses the version-specific file as the Release body, followed by generated download links, package checksums and signing information. Rerunning publication updates the body as well as the assets. Keep version-specific descriptions in the notes file instead of hardcoding them in the workflow.

Verify the public GitHub Release after publication: matching tag and version, the reviewed notes displayed above download information, and all expected installers, portable archives and checksum files present. A README change, artifact or comparison link alone is not a completed release log.
