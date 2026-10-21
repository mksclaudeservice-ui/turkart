import { defineConfig } from 'vite';

// På GitHub Pages ligger appen under /turkart/. BASE settes i deploy-workflowen.
export default defineConfig({
  base: process.env.BASE ?? '/'
});
