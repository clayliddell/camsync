# vid.skrrt.party deployment

- Public application URL: https://vid.skrrt.party/
- Source repository: https://github.com/clayliddell/camsync
- GitHub Pages source: GitHub Actions, `.github/workflows/pages.yml`
- Porkbun DNS: `CNAME` host `vid`, value `clayliddell.github.io`, TTL `600`
- The existing `skrrt.party` root-domain record is separate from this subdomain.

Push app changes to `main` to deploy. The workflow checks the retention rules and JavaScript syntax, packages only the static app and icons, and deploys the artifact. Tests, documentation, dependencies, and recordings are not part of the hosted artifact.

In GitHub repository **Settings → Pages**, the custom domain is `vid.skrrt.party`. Enable **Enforce HTTPS** after GitHub provisions the certificate. GitHub manages certificate renewals.

Google sign-in also requires a public OAuth client ID in `config.js`, an enabled Google Drive API, and `https://vid.skrrt.party` under that web client's authorized JavaScript origins. See `README.md`. Until configured, users can record locally, but cannot connect Google Drive.

The Google Cloud project for this deployment is `camsync-512516`. The Google Drive API is enabled. No virtual machine, application backend, or Cloud Storage bucket is required.

## Cost expectations

Normal use is expected to cost $0 beyond the existing domain registration and any Drive storage plan a user chooses to purchase. Public GitHub Pages and the workflow's standard hosted runner are free under [GitHub's current plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans). [Standard Drive API usage](https://developers.google.com/workspace/drive/api/guides/limits) currently carries no additional charge, but Google has announced future charges above standard daily thresholds. Do not treat a linked billing account as a spending cap or assume unlimited free API usage. Recordings count against each connected user's own Drive storage.

Do not change the deployment origin after users start recording: browser storage belongs to the origin. Updates on the same domain retain access to phone data. Bump the service-worker version when changing app files or configuration.
