import mongoose from 'mongoose';

/** Adds a required, indexed organizationId to tenant-owned collections. */
export function tenantPlugin(schema) {
  // Skip the plain index when the schema already declares one on organizationId alone (e.g. unique per company)
  const declared = schema.indexes().some(([fields]) => Object.keys(fields).length === 1 && fields.organizationId);
  schema.add({
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: !declared },
  });
}

export const { ObjectId } = mongoose.Schema.Types;

export function model(name, schema, { tenant = true } = {}) {
  if (tenant) schema.plugin(tenantPlugin);
  schema.set('timestamps', true);
  schema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: (_, ret) => {
      delete ret._id;
      return ret;
    },
  });
  return mongoose.models[name] || mongoose.model(name, schema);
}
