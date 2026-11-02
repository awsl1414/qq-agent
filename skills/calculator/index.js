// 计算器插件
// 演示如何安全地执行数学表达式
//
// v1.1.0 新增：
//   - 幂运算：x ^ y（在 calculate 的 expression 里用 ^，内部转成 **）
//   - 平方根：sqrt(x)（在 calculate 的 expression 里直接用）
//   - 进制转换：新增 base_convert 工具（十进制与二/八/十六进制互转）
// 原有 calculate 工具的 id 与参数结构（expression）保持不变，四则运算行为不变。

export function register(api) {
  // ── 工具 1：calculate（原有工具，签名不变）────────────────────────────
  // 在原有 + - * / % 括号 的基础上，额外支持 ^（幂）与 sqrt()（平方根）。
  // 原来的合法表达式仍是合法表达式，行为完全一致。
  api.registerTool({
    id: 'calculate',
    name: '计算',
    description: '计算一个数学表达式（支持 + - * / % 括号，以及 ^ 幂运算和 sqrt() 平方根）。适用：群友问"1+1等于几"、"帮我算一下 123*456"、"2的10次方"、"sqrt(144)"。',
    category: 'system',
    icon: '🧮',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式（如：1+2*3、2^10、sqrt(16)）' }
      },
      required: ['expression']
    },
    async execute(ctx, args) {
      const expr = String(args.expression ?? '').trim();
      if (!expr) return { content: '错误：请提供要计算的表达式', isError: true };

      // 安全检查：只允许数字、运算符、括号、小数点，以及 sqrt 这几个字母和逗号。
      // 这是原白名单的超集，原有表达式不受影响。
      if (!/^[\d\s+\-*/%().^a-z,]+$/.test(expr)) {
        return { content: '错误：表达式包含不允许的字符（只允许数字和 + - * / % ( ) ^，以及 sqrt）', isError: true };
      }
      // 只允许 sqrt 这一个标识符，防止 Function 里塞入其它代码
      if (/[a-z]+/.test(expr.replace(/sqrt/g, ''))) {
        return { content: '错误：表达式包含不支持的函数或字母（目前只支持 sqrt）', isError: true };
      }
      // 幂运算：把 ^ 换成 JS 的 **
      const jsExpr = expr.replace(/\^/g, '**');

      try {
        // 使用 Function 构造器（比 eval 安全一点，但仍需输入校验）
        const result = new Function('sqrt', `return (${jsExpr})`)(Math.sqrt);
        if (typeof result !== 'number' || !Number.isFinite(result)) {
          throw new Error('计算结果无效');
        }
        return {
          content: JSON.stringify({
            expression: expr,
            result,
            note: `${expr} = ${result}`
          }, null, 1)
        };
      } catch (error) {
        return { content: `计算失败：${error.message}`, isError: true };
      }
    }
  });

  // ── 工具 2：base_convert（v1.1.0 新增）──────────────────────────────
  api.registerTool({
    id: 'base_convert',
    name: '进制转换',
    description: '把数字在十进制与二/八/十六进制之间互转。适用：群友问"255 转成十六进制是多少"、"二进制 1010 是十进制的几"。',
    category: 'system',
    icon: '🔢',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string', description: '要转换的数字，如 "255" 或 "1010"' },
        fromBase: { type: 'integer', description: '源进制，只能是 2、8、10、16，默认 10', enum: [2, 8, 10, 16] },
        toBase: { type: 'integer', description: '目标进制，只能是 2、8、10、16', enum: [2, 8, 10, 16] }
      },
      required: ['value', 'toBase']
    },
    async execute(ctx, args) {
      const raw = String(args.value ?? '').trim().replace(/^0[bBoOxX]/, '');
      const toBase = Number(args.toBase);
      const fromBase = Number(args.fromBase ?? 10);
      const allowed = [2, 8, 10, 16];

      if (!raw) return { content: '错误：请提供要转换的数字', isError: true };
      if (!allowed.includes(toBase)) {
        return { content: '错误：目标进制只支持 2、8、10、16', isError: true };
      }
      if (!allowed.includes(fromBase)) {
        return { content: '错误：源进制只支持 2、8、10、16', isError: true };
      }

      // 负数支持：-FF、-1010 等
      const negative = raw.startsWith('-');
      const digits = negative ? raw.slice(1) : raw;
      if (!digits || !/^[0-9a-fA-F]+$/.test(digits)) {
        return { content: '错误：数字格式不合法（只允许 0-9 与 A-F）', isError: true };
      }

      // 校验每一位都在源进制范围内（如二进制里不能出现 2）
      for (const ch of digits) {
        if (parseInt(ch, 16) >= fromBase) {
          return { content: `错误：${ch} 不是合法的 ${fromBase} 进制数字`, isError: true };
        }
      }
      const parsed = parseInt(digits, fromBase);
      if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
        return { content: `错误：这不是一个合法的 ${fromBase} 进制数字`, isError: true };
      }

      const result = (negative ? '-' : '') + parsed.toString(toBase).toUpperCase();
      return {
        content: JSON.stringify({
          value: (negative ? '-' : '') + digits.toUpperCase(),
          fromBase,
          toBase,
          result,
          note: `${fromBase} 进制 ${(negative ? '-' : '') + digits.toUpperCase()} = ${toBase} 进制 ${result}`
        }, null, 1)
      };
    }
  });
}
