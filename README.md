# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## Deploying to AWS

The site is served from https://patelpb.com by CloudFront (distribution `EPJNH9PK97GV8`) in front of the private S3 bucket `patelpb-com-site` (Origin Access Control; `www.patelpb.com` 301-redirects to the apex).

```sh
aws login --region us-east-1   # once per session
npm run deploy:aws             # build, sync dist/ to S3, invalidate CloudFront
```

`scripts/deploy-aws.sh` uploads Vite's hashed `assets/*-<hash>.*` files with `Cache-Control: public, max-age=31536000, immutable` and everything else with `public, max-age=300`, setting content types explicitly (e.g. `.parquet` → `application/octet-stream`, `.md` → `text/markdown; charset=utf-8`). Override the targets with `AWS_S3_BUCKET` / `AWS_CF_DISTRIBUTION_ID`; `SKIP_BUILD=1`, `SKIP_INVALIDATION=1` and `DRYRUN=1` are also supported.

The viewer-request CloudFront Function lives in `scripts/cloudfront-viewer-request.js`: it redirects `www` to the apex, serves `index.html` for URIs ending in `/` (e.g. `/projects/atp/`), and 301s extensionless paths to their trailing-slash form so relative links in subdirectory pages resolve. After editing it, update and publish it with `aws cloudfront update-function` / `publish-function` (name `patelpb-com-viewer-request`).

The GitHub Pages deploy (`npm run deploy`) still works as before.

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
