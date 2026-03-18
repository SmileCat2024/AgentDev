import { VisualFeature } from './dist/features/visual/index.js';

const feature = new VisualFeature();
console.log('PackageInfo:', feature.getPackageInfo());
console.log('TemplateNames:', feature.getTemplateNames());
console.log('name:', feature.name);
