/** 文件在打开前后用于检测路径替换与身份变化的设备号与 inode 二元组。 */
export interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}
