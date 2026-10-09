import { helper } from '@/lib/util';

// Not a real import — just a string that happens to look like one. A regex
// import-extractor will misread this as `import('./lib/shouldNotCount')`.
export const decoyReference = "import('./lib/shouldNotCount')";

export function run(): number {
  return helper();
}
