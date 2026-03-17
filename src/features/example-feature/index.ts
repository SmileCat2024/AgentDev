import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type {
  AgentFeature,
  FeatureContext,
  FeatureInitContext,
  FeatureStateSnapshot,
  ContextInjector,
  PackageInfo,
} from '../../core/feature.js';
import type { Tool } from '../../core/types.js';
import type {
  CallStartContext,
  StepFinishDecisionContext,
  ToolContext,
} from '../../core/lifecycle.js';
import { CallStart, StepFinish, ToolUse } from '../../core/hooks-decorator.js';
import { Decision } from '../../core/lifecycle.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { createExampleTool } from './tools.js';
import type {
  ExampleFeatureConfig,
  ExampleFeatureRuntimeState,
  ExampleFeatureSnapshot,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ExampleFeature implements AgentFeature {
  readonly name = 'example-feature';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '示范用 Feature 骨架：展示工具、模板、上下文注入、回滚快照和反向钩子的标准写法。';

  private readonly config: Required<ExampleFeatureConfig>;
  private readonly runtime: ExampleFeatureRuntimeState = {
    enabled: true,
    counter: 0,
    lastInput: '',
    notes: [],
  };
  private logger?: FeatureInitContext['logger'];

  private _packageInfo: PackageInfo | null = null;

  constructor(config: ExampleFeatureConfig = {}) {
    this.config = {
      enabledByDefault: config.enabledByDefault ?? true,
      notePrefix: config.notePrefix ?? '[example]',
    };
    this.runtime.enabled = this.config.enabledByDefault;
  }

  /**
   * 公开 API 只保留“其他 Feature 真会读取的东西”。
   * 不要把整个 runtime 对象直接暴露出去。
   */
  isEnabled(): boolean {
    return this.runtime.enabled;
  }

  getCounter(): number {
    return this.runtime.counter;
  }

  listNotes(): string[] {
    return [...this.runtime.notes];
  }

  /**
   * 内部 helper 比直接在装饰器和工具里散改字段更容易维护。
   * 如果 Feature 很简单，也可以不抽这些方法。
   */
  private appendNote(note: string): void {
    const normalized = note.trim();
    if (!normalized) return;
    this.runtime.notes.push(`${this.config.notePrefix} ${normalized}`.trim());
  }

  private setEnabled(enabled: boolean): void {
    this.runtime.enabled = enabled;
  }

  private buildReminder(): string {
    return `${this.config.notePrefix} example feature is active`;
  }

  getTools(): Tool[] {
    return [
      createExampleTool({
        getState: () => this.runtime,
        incrementCounter: () => {
          this.runtime.counter += 1;
        },
        addNote: (note: string) => {
          this.appendNote(note);
        },
      }),
    ];
  }

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   */
  getTemplateNames(): string[] {
    // 两个别名指向同一个模板文件
    return ['example-tool', 'example_tool'];
  }

  getContextInjectors(): Map<string | RegExp, ContextInjector> {
    return new Map([
      ['example_tool', () => ({
        _exampleFeature: {
          enabled: this.runtime.enabled,
          counter: this.runtime.counter,
        },
      })],
    ]);
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;

    // 在这里做一次性初始化：
    // - 创建 client
    // - 注册数据源
    // - 加载配置文件
    // - 打印启动日志
    this.logger?.info('ExampleFeature initiated', {
      enabled: this.runtime.enabled,
      counter: this.runtime.counter,
    });

    // 如果 Feature 依赖其他 Feature，优先在这里拿公开 API：
    // const other = ctx.getFeature<SomePublicApi & AgentFeature>('other-feature');
    // 不要把其他 Feature 的内部字段当成稳定接口。
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 在这里做资源清理：
    // - 关闭 client
    // - 停止 worker / interval
    // - 释放文件句柄
    this.logger?.info('ExampleFeature destroyed');
  }

  captureState(): FeatureStateSnapshot {
    const snapshot: ExampleFeatureSnapshot = {
      enabled: this.runtime.enabled,
      counter: this.runtime.counter,
      lastInput: this.runtime.lastInput,
      notes: [...this.runtime.notes],
    };
    return snapshot;
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as ExampleFeatureSnapshot;

    this.runtime.enabled = Boolean(state.enabled);
    this.runtime.counter = typeof state.counter === 'number' ? state.counter : 0;
    this.runtime.lastInput = typeof state.lastInput === 'string' ? state.lastInput : '';
    this.runtime.notes = [...(state.notes ?? [])];
  }

  async beforeRollback(snapshot: FeatureStateSnapshot): Promise<void> {
    const state = snapshot as ExampleFeatureSnapshot;
    this.logger?.info('ExampleFeature before rollback', {
      restoringCounter: state.counter,
    });
  }

  async afterRollback(snapshot: FeatureStateSnapshot): Promise<void> {
    const state = snapshot as ExampleFeatureSnapshot;
    this.logger?.info('ExampleFeature after rollback', {
      restoredCounter: state.counter,
    });
  }

  @CallStart
  async handleCallStart(ctx: CallStartContext): Promise<void> {
    this.runtime.lastInput = ctx.agent?.getUserInput() ?? ctx.input;

    // 典型用法：
    // - slash command 改写输入
    // - 模式切换
    // - 注入轻量 system reminder
    // - 记录当前轮的轻量状态

    // 示例 1：处理一个最简单的 slash command
    // if (this.runtime.lastInput === '/example-off') {
    //   this.setEnabled(false);
    //   ctx.agent?.setUserInput('');
    // }

    // 示例 2：仅在模式开启时注入提醒
    // if (this.runtime.enabled) {
    //   ctx.context.add({ role: 'system', content: this.buildReminder() });
    // }
  }

  @ToolUse
  async validateExampleTool(ctx: ToolContext): Promise<typeof Decision.Continue | typeof Decision.Deny> {
    if (ctx.call.name !== 'example_tool') {
      return Decision.Continue;
    }

    // 典型用法：
    // - 校验参数
    // - 拦截危险工具调用
    // - 改写 call.arguments

    // 示例：模式关闭时拒绝执行
    // if (!this.runtime.enabled) {
    //   return {
    //     action: Decision.Deny,
    //     reason: 'example feature disabled',
    //   };
    // }

    // 示例：标准化参数后继续
    // if (typeof ctx.call.arguments?.note === 'string') {
    //   ctx.call.arguments.note = ctx.call.arguments.note.trim();
    // }

    return Decision.Continue;
  }

  @StepFinish
  async handleStepFinish(ctx: StepFinishDecisionContext): Promise<typeof Decision.Continue> {
    // 典型用法：
    // - 统计本轮是否命中特定工具
    // - 决定是否继续下一轮
    // - 更新 reminder 计数器

    // 示例：只有当本轮真的用了本 Feature 的工具，才更新某个计数器
    // const usedExampleTool = ctx.llmResponse.toolCalls?.some(call => call.name === 'example_tool');
    // if (usedExampleTool) {
    //   this.appendNote('tool used in this step');
    // }

    return Decision.Continue;
  }
}
