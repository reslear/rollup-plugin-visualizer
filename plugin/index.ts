import { promises as fs } from "fs";
import path from "path";

import { OutputBundle, Plugin, NormalizedOutputOptions } from "rollup";
import opn from "open";

import { version } from "./version";

import { createGzipSizeGetter, createBrotliSizeGetter, SizeGetter } from "./compress";

import pkg from "../package.json";
import { TemplateType } from "./template-types";
import { ModuleMapper } from "./module-mapper";
import { addLinks, buildTree, mergeTrees, removeCommonPrefix } from "./data";
import { getSourcemapModules } from "./sourcemap";
import { buildHtml } from "./build-stats";
import { ModuleLink, ModuleRenderSizes, ModuleTree, ModuleTreeLeaf, VisualizerData } from "../types/types";

const WARN_SOURCEMAP_DISABLED =
  "rollup output configuration missing sourcemap = true. You should add output.sourcemap = true or disable sourcemap in this plugin";

const WARN_SOURCEMAP_MISSING = (id: string) => `${id} missing source map`;

export interface PluginVisualizerOptions {
  json?: boolean;
  filename?: string;
  title?: string;
  open?: boolean;
  openOptions?: opn.Options;
  template?: TemplateType;
  gzipSize?: boolean;
  brotliSize?: boolean;
  sourcemap?: boolean;
}

interface AdditionalRenderInfo {
  gzipLength?: number;
  brotliLength?: number;
}

const defaultSizeGetter: SizeGetter = () => Promise.resolve(0);

const plugin = (opts: PluginVisualizerOptions = {}): Plugin => {
  const json = !!opts.json;
  const filename = opts.filename ?? (json ? "stats.json" : "stats.html");
  const title = opts.title ?? "RollUp Visualizer";

  const open = !!opts.open;
  const openOptions = opts.openOptions ?? {};

  const template = opts.template ?? "treemap";

  const gzipSize = !!opts.gzipSize;
  const brotliSize = !!opts.brotliSize;
  const additionalFilesInfo = new Map<string, AdditionalRenderInfo>();
  const gzipSizeGetter = gzipSize
    ? createGzipSizeGetter(typeof opts.gzipSize === "object" ? opts.gzipSize : {})
    : defaultSizeGetter;
  const brotliSizeGetter = brotliSize
    ? createBrotliSizeGetter(typeof opts.brotliSize === "object" ? opts.brotliSize : {})
    : defaultSizeGetter;

  const getAdditionalFilesInfo = async (id: string, code: string) => {
    const info: AdditionalRenderInfo = {};
    if (gzipSize) {
      info.gzipLength = await gzipSizeGetter(code);
    }
    if (brotliSize) {
      info.brotliLength = await brotliSizeGetter(code);
    }
    return info;
  };

  return {
    name: "visualizer",

    async transform(code, id) {
      additionalFilesInfo.set(id, await getAdditionalFilesInfo(id, code));
      return null;
    },

    async generateBundle(outputOptions: NormalizedOutputOptions, outputBundle: OutputBundle): Promise<void> {
      if (opts.sourcemap && !outputOptions.sourcemap) {
        this.warn(WARN_SOURCEMAP_DISABLED);
      }

      const roots: Array<ModuleTree | ModuleTreeLeaf> = [];
      const mapper = new ModuleMapper();
      const links: ModuleLink[] = [];

      // collect trees
      for (const [bundleId, bundle] of Object.entries(outputBundle)) {
        if (bundle.type !== "chunk") continue; //only chunks

        let tree: ModuleTree;

        if (opts.sourcemap) {
          if (!bundle.map) {
            this.warn(WARN_SOURCEMAP_MISSING(bundleId));
          }

          const modules = await getSourcemapModules(
            bundleId,
            bundle,
            outputOptions.dir ?? (outputOptions.file && path.dirname(outputOptions.file)) ?? process.cwd()
          );

          tree = buildTree(Object.entries(modules), mapper);
        } else {
          const modules = Object.entries(bundle.modules);

          tree = buildTree(modules, mapper);
        }

        tree.name = bundleId;

        if (tree.children.length === 0) {
          const bundleInfo = await getAdditionalFilesInfo(bundleId, bundle.code);
          const bundleSizes: ModuleRenderSizes = { ...bundleInfo, renderedLength: bundle.code.length };
          const facadeModuleId = bundle.facadeModuleId ?? "unknown";
          const moduleId = bundle.isEntry ? `entry-${facadeModuleId}` : facadeModuleId;
          const bundleUid = mapper.setValueByModuleId(moduleId, { isEntry: true, ...bundleSizes, id: moduleId });
          const leaf: ModuleTreeLeaf = { name: bundleId, uid: bundleUid };
          roots.push(leaf);
        } else {
          roots.push(tree);
        }
      }

      // after trees we process links (this is mostly for uids)
      for (const bundle of Object.values(outputBundle)) {
        if (bundle.type !== "chunk" || bundle.facadeModuleId == null) continue; //only chunks

        addLinks(bundle.facadeModuleId, this.getModuleInfo.bind(this), links, mapper);
      }

      const { nodes, nodeIds } = mapper;
      for (const [id, uid] of Object.entries(nodeIds)) {
        if (nodes[uid]) {
          const newInfo = additionalFilesInfo.get(id) || {};
          if (nodes[uid].renderedLength === 0) {
            if (gzipSize) {
              newInfo.gzipLength = 0;
            }
            if (brotliSize) {
              newInfo.brotliLength = 0;
            }
          }
          nodes[uid] = {
            ...nodes[uid],
            ...newInfo,
          };
        } else {
          this.warn(`Could not find mapping for node ${id} ${uid}`);
        }
      }

      removeCommonPrefix(nodes, nodeIds);

      for (const [id, uid] of Object.entries(nodeIds)) {
        if (nodes[uid]) {
          nodes[uid].id = id;
        } else {
          this.warn(`Could not find mapping for node ${id} ${uid}`);
        }
      }

      const tree = mergeTrees(roots);

      const data: VisualizerData = {
        version,
        tree,
        nodes,
        links,
        env: {
          rollup: this.meta.rollupVersion,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          [pkg.name]: pkg.version,
        },
        options: {
          gzip: gzipSize,
          brotli: brotliSize,
          sourcemap: !!opts.sourcemap,
        },
      };

      const fileContent: string = json
        ? JSON.stringify(data, null, 2)
        : await buildHtml({
            title,
            data,
            template,
          });

      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, fileContent);

      if (open) {
        await opn(filename, openOptions);
      }
    },
  };
};

export default plugin;
