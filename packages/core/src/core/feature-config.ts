/**
 * Feature 配置队列解析（config queue）
 *
 * 框架不认识"层"（global/agent/dir/profile 都是产品语义），只接受一个有序
 * 配置数组，按序 deep merge 出最终配置，并同步产出 provenance 与 warnings。
 *
 * 本模块是队列 merge 与 provenance 的唯一权威实现：纯函数、无 IO、无 logger、
 * 无进程状态；warning 以返回值交付，由调用方决定记日志方式。
 *
 * merge 规范（D5）：
 * 1. 对象：递归合并（同 key 且两侧均为普通对象时深入）
 * 2. 标量：替换（后层胜）
 * 3. 数组：整体替换，绝不按索引/按 key 合并
 * 4. null：视为"删除该字段"，从合并结果移除并产生 warning
 * 5. 未出现的 key：继承（不写入即不覆盖）
 * 6. 空队列返回空结果
 */

/**
 * 单个 feature 的配置对象形态。顶层 key = featureName（如 'lsp'、'shell'），
 * 值为该 feature 的配置对象。
 */
export type FeatureConfig = Record<string, unknown>;

/**
 * 某个点路径字段的来源信息。
 */
export interface ConfigProvenanceEntry {
  /** 该字段最终生效值 */
  value: unknown;
  /** 队列中最后写入该字段的元素索引 */
  sourceIndex: number;
}

/**
 * 解析过程中产生的警告。第一版只有 null 删除一种。
 */
export interface ConfigWarning {
  /** 点路径，如 'lsp.typescript.mode' */
  fieldPath: string;
  /** 触发该警告的队列元素索引 */
  layerIndex: number;
  kind: 'null-removed';
  message: string;
}

/**
 * resolveFeatureConfig 的返回结构。provenance 的 key 是完整点路径
 * （含 featureName 前缀）。
 */
export interface ResolvedFeatureConfig {
  /** 最终合并配置 */
  merged: FeatureConfig;
  /** key = 完整点路径（如 'lsp.typescript.mode'） */
  provenance: Record<string, ConfigProvenanceEntry>;
  warnings: ConfigWarning[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 整体赋值前深拷贝，保证输入队列不被结果持有引用（纯函数纪律）。 */
function copyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copyValue);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = copyValue(v);
    }
    return out;
  }
  return value;
}

/**
 * 把有序配置队列按序 deep merge 为最终配置。
 *
 * @param queue 有序配置数组，顶层按 featureName 分桶；越靠后优先级越高
 */
export function resolveFeatureConfig(queue: FeatureConfig[]): ResolvedFeatureConfig {
  const merged: FeatureConfig = {};
  const provenance: Record<string, ConfigProvenanceEntry> = {};
  const warnings: ConfigWarning[] = [];

  const removeProvenanceSubtree = (path: string): void => {
    delete provenance[path];
    const prefix = `${path}.`;
    for (const key of Object.keys(provenance)) {
      if (key.startsWith(prefix)) {
        delete provenance[key];
      }
    }
  };

  // 单次遍历：merge 与 provenance 同源（D6），逐层把 layerValue 并入 target
  const applyLayer = (
    target: Record<string, unknown>,
    layerValue: Record<string, unknown>,
    prefix: string,
    layerIndex: number,
  ): void => {
    for (const [key, incoming] of Object.entries(layerValue)) {
      const path = prefix ? `${prefix}.${key}` : key;

      // 规范 4：null 按删除处理并产生 warning
      if (incoming === null) {
        delete target[key];
        removeProvenanceSubtree(path);
        warnings.push({
          fieldPath: path,
          layerIndex,
          kind: 'null-removed',
          message: `字段 '${path}' 在第 ${layerIndex} 层被置为 null，已从合并结果中删除`,
        });
        continue;
      }

      const existing = target[key];

      // 规范 1：两侧均为普通对象时递归合并
      if (isPlainObject(existing) && isPlainObject(incoming)) {
        applyLayer(existing, incoming, path, layerIndex);
        continue;
      }

      if (isPlainObject(incoming)) {
        // 新出现的对象分支：建新容器后继续深入；
        // 若该路径此前是叶子值，先清掉其 provenance 再替换
        removeProvenanceSubtree(path);
        const branch: Record<string, unknown> = {};
        target[key] = branch;
        applyLayer(branch, incoming, path, layerIndex);
        continue;
      }

      // 规范 2 / 3：标量与数组整体替换（数组绝不按索引合并）
      target[key] = copyValue(incoming);
      provenance[path] = { value: target[key], sourceIndex: layerIndex };
    }
  };

  queue.forEach((layer, layerIndex) => {
    if (isPlainObject(layer)) {
      applyLayer(merged, layer, '', layerIndex);
    }
  });

  return { merged, provenance, warnings };
}
