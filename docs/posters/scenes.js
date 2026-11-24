// Poster rendering only: sample data for the side panel (see stub.js). Nothing here is real user data.
(() => {
  const t0 = Date.UTC(2026, 10, 24, 9, 0, 0);
  const at = (s) => t0 + s * 1000;
  // Steps are recorded about a second apart, so the panel shows no "wait" rows.
  const page = { url: 'https://shop.example.com/admin/orders', title: 'Orders — Shop admin' };
  const tgt = (kind, label, selector, tag = 'button') => ({ tag, kind, label, selector });

  const orderSteps = [
    { id: 's1', type: 'navigate', transition: 'typed', t: at(0), tEnd: t0 + 900, ...page },
    { id: 's2', type: 'click', t: at(1), target: tgt('button', 'New order', '#new-order'), ...page },
    { id: 's3', type: 'type', t: at(2), value: '{{customer}}', target: tgt('textbox', 'Customer', '#customer', 'input'), ...page },
    { id: 's4', type: 'select', t: at(3), value: '{{plan}}', target: tgt('combobox', 'Plan', '#plan', 'select'), ...page },
    { id: 's5', type: 'type', t: at(4), value: '{{seats}}', target: tgt('textbox', 'Seats', '#seats', 'input'), ...page },
    { id: 's6', type: 'click', t: at(5), target: tgt('button', 'Create order', 'form button[type=submit]'), ...page },
    { id: 's7', type: 'verify', t: at(6), check: { mode: 'present', keywords: ['Order created'] }, result: { passed: true, details: [{ keyword: 'Order created', count: 1 }] }, ...page },
  ];
  const orderVars = [
    { name: 'customer', value: 'Acme Ltd' },
    { name: 'plan', value: 'Pro' },
    { name: 'seats', value: '25' },
  ];

  const testSteps = [
    { id: 't1', type: 'navigate', transition: 'typed', t: at(0), tEnd: t0 + 800, url: 'https://shop.example.com/login', title: 'Sign in' },
    { id: 't2', type: 'type', t: at(1), value: '{{email}}', target: tgt('textbox', 'Email', '#email', 'input'), url: 'https://shop.example.com/login' },
    { id: 't3', type: 'type', t: at(2), sensitive: true, value: '{{password}}', target: tgt('textbox', 'Password', '#password', 'input'), url: 'https://shop.example.com/login' },
    { id: 't4', type: 'click', t: at(3), target: tgt('button', 'Sign in', '#signin'), url: 'https://shop.example.com/login' },
    {
      id: 't5', type: 'test', t: at(4), name: 'Dashboard opens', expected: 'The dashboard greets the user', onFail: 'continue',
      conds: [{ source: 'page', op: 'contains', value: 'Welcome back' }, { source: 'url', op: 'contains', value: '/dashboard' }],
      url: 'https://shop.example.com/dashboard',
    },
    {
      id: 't6', type: 'test', t: at(5), name: 'No error banner', onFail: 'continue',
      conds: [{ source: 'page', op: 'notContains', value: 'Something went wrong' }],
      url: 'https://shop.example.com/dashboard',
    },
  ];

  const flow = (id, name, group, steps, extra = {}) => ({ id, name, group, savedAt: t0, startedAt: steps[0].t, stoppedAt: steps[steps.length - 1].t + 2000, steps, ...extra });
  const flows = [
    flow('f1', 'Create order', 'Billing', orderSteps, { vars: orderVars }),
    flow('f2', 'Refund an order', 'Billing', orderSteps.slice(0, 4)),
    flow('f3', 'Invite a teammate', 'Onboarding', orderSteps.slice(0, 5)),
    flow('f4', 'Set up a new workspace', 'Onboarding', orderSteps.slice(0, 6)),
    flow('f5', 'Login smoke test', 'Smoke tests', testSteps),
    flow('f6', 'Checkout smoke test', 'Smoke tests', testSteps.slice(0, 5)),
  ];
  const groups = [{ name: 'Onboarding' }, { name: 'Billing' }, { name: 'Smoke tests' }];

  window.SCENES = {
    rec: { recording: false, startedAt: t0, stoppedAt: at(7), steps: orderSteps, vars: orderVars, flows, groups, envs: [] },
    test: { recording: false, startedAt: t0, stoppedAt: at(6), steps: testSteps, vars: [{ name: 'email', value: 'qa@example.com' }, { name: 'password', secret: true }], flows, groups, envs: [] },
    flows: { recording: false, steps: [], vars: [], flows, groups, envs: [] },
  };
})();
