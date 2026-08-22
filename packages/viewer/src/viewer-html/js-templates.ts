export const VIEWER_JS_TEMPLATES = `    /**
     * 根据模板名解析文件路径
     * 模板 URL 由 ViewerWorker 从注册事实生成（/tpl/{mountId}/{rel}），不透明、不含布局知识。
     * 未注册的模板名一律等待 FEATURE_TEMPLATE_MAP 加载，不做任何本地路径推断。
     */
    const self = this;

    function resolveTemplatePath(templateName) {
      // 1. 查找 Feature 模板（从后端注入的动态数据）
      if (FEATURE_TEMPLATE_MAP[templateName]) {
        return FEATURE_TEMPLATE_MAP[templateName];
      }

      // 2. 兜底：返回 null，让调用者等待或使用默认模板
      // 模板缺失本质是装配缺陷，应被看见而不是被本地猜测掩盖
      console.warn('[Viewer] Template "' + templateName + '" not found in FEATURE_TEMPLATE_MAP, waiting...');
      return null;
    }

    /**
     * 异步加载模板
     * 支持从 Feature 目录或系统目录加载
     * 如果加载失败，回退到内置模板
     */
    async function loadTemplate(templateName, retryCount = 0) {
      if (templateCache.has(templateName)) {
        return templateCache.get(templateName);
      }

      // 优先检查内置模板（json 是内置的）
      if (RENDER_TEMPLATES[templateName]) {
        templateCache.set(templateName, RENDER_TEMPLATES[templateName]);
        return RENDER_TEMPLATES[templateName];
      }

      try {
        const path = resolveTemplatePath(templateName);

        // 如果 path 为 null，说明 FEATURE_TEMPLATE_MAP 还未加载完成
        if (!path) {
          // 最多重试 3 次，每次等待 500ms
          if (retryCount < 3) {
            console.log('[Viewer] Waiting for FEATURE_TEMPLATE_MAP to load... (attempt ' + (retryCount + 1) + ')');
            await new Promise(resolve => setTimeout(resolve, 500));
            // 重新加载模板映射
            await loadFeatureTemplateMap();
            return loadTemplate(templateName, retryCount + 1);
          }
          console.warn('[Viewer] Template "' + templateName + '" not found after retries');
          // 回退到内置 json 模板
          if (RENDER_TEMPLATES['json']) {
            return RENDER_TEMPLATES['json'];
          }
          return null;
        }

        // 统一使用 URL 方式加载模板（URL 由服务端注册事实生成，不透明）
        // 失败时回退到内置 json 模板但不写入缓存，下次渲染重试真实模板
        const module = await import(path);

        // 1. 优先使用 default export（Feature 模板）
        let template = module.default;
        if (template) {
          templateCache.set(templateName, template);
          return template;
        }

        // 2. 尝试从 TEMPLATES 对象获取（系统模板）
        if (module.TEMPLATES && module.TEMPLATES[templateName]) {
          template = module.TEMPLATES[templateName];
          templateCache.set(templateName, template);
          return template;
        }

        console.warn('[Viewer Worker] 模板 "' + templateName + '" 在文件中未找到');
        return null;
      } catch (e) {
        console.warn('[Viewer Worker] 加载模板失败: ' + templateName, e);
        // 回退到内置 json 模板
        if (RENDER_TEMPLATES['json']) {
          return RENDER_TEMPLATES['json'];
        }
        return null;
      }
    }

    function getToolRenderTemplate(toolName) {
      const config = toolRenderConfigs[toolName];
      const callTemplateName = (config?.render?.call) || 'json';
      const resultTemplateName = (config?.render?.result) || 'json';

      const callIsInline = callTemplateName === '__inline__';
      const resultIsInline = resultTemplateName === '__inline__';

      let callTemplate, resultTemplate;

      if (callIsInline) {
        callTemplate = config?.render?.inlineCall;
      } else {
        // 优先从缓存读取
        const cached = templateCache.get(callTemplateName);
        callTemplate = cached?.call || RENDER_TEMPLATES['json'].call;
      }

      if (resultIsInline) {
        resultTemplate = config?.render?.inlineResult;
      } else {
        const cached = templateCache.get(resultTemplateName);
        resultTemplate = cached?.result || RENDER_TEMPLATES['json'].result;
      }

      return {
        call: callTemplate,
        result: resultTemplate,
        isInlineCall: callIsInline,
        isInlineResult: resultIsInline,
      };
    }

    function getToolDisplayName(toolName) {
      return TOOL_NAMES[toolName] || toolName;
    }
`;
