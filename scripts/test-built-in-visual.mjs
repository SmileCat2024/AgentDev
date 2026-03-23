// DEPRECATED: 临时调试脚本，不再维护
// 如需测试 visual feature，请在 src/features/visual/test/ 中使用正式测试
import { VisualFeature } from './dist/features/visual/index.js';

const feature = new VisualFeature();
console.log('PackageInfo:', feature.getPackageInfo());
console.log('TemplateNames:', feature.getTemplateNames());
console.log('name:', feature.name);
