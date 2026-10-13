/** 文件在打开前后用于检测路径替换与身份变化的设备号与 inode 二元组。 */
export interface FileIdentity {
  /** 文件所在设备的编号；与 inode 组合才能唯一标识一个文件对象。 */
  readonly device: number;
  /** 文件在其设备内的 inode 编号；文件被删除重建后该值会改变，据此可检测身份替换。 */
  readonly inode: number;
}
