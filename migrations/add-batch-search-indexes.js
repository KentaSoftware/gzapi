// ============================================
// MIGRATION: Add Indexes for Batch Catalog Search
// Version: 0.6.0
// Date: 2024-12-30
// ============================================

// Connect to MongoDB
// mongo mongodb://localhost:27017/golozur

// ============================================
// 1. CREATE INDEXES FOR BATCH SEARCH
// ============================================

print("Creating indexes for batch catalog search...");

// Index for barcode exact match
db.products.createIndex(
  { codigoBarra: 1 },
  { 
    name: "idx_codigoBarra",
    background: true 
  }
);
print("✓ Index created: { codigoBarra: 1 }");

// Compound index for provider + text search
db.products.createIndex(
  { proveedor: 1, descripcion: 1 },
  { 
    name: "idx_proveedor_descripcion",
    background: true 
  }
);
print("✓ Index created: { proveedor: 1, descripcion: 1 }");

// ============================================
// 2. VERIFY INDEXES
// ============================================

print("\n=== Current indexes on products collection ===");
db.products.getIndexes().forEach(function(index) {
  print(JSON.stringify(index, null, 2));
});

// ============================================
// 3. ANALYZE INDEX USAGE (Optional)
// ============================================

print("\n=== Sample query with explain (barcode) ===");
var explainBarcode = db.products.find({ codigoBarra: "7790742001016" }).explain("executionStats");
print("Execution time (ms): " + explainBarcode.executionStats.executionTimeMillis);
print("Documents examined: " + explainBarcode.executionStats.totalDocsExamined);
print("Documents returned: " + explainBarcode.executionStats.nReturned);
print("Index used: " + (explainBarcode.executionStats.executionStages.indexName || "N/A"));

print("\n=== Sample query with explain (provider + text) ===");
var explainText = db.products.find({ 
  proveedor: ObjectId("60d5ec49f1b2c8b1f8c8e8e8"), 
  descripcion: /coca/i 
}).explain("executionStats");
print("Execution time (ms): " + explainText.executionStats.executionTimeMillis);
print("Documents examined: " + explainText.executionStats.totalDocsExamined);
print("Documents returned: " + explainText.executionStats.nReturned);
print("Index used: " + (explainText.executionStats.executionStages.indexName || "N/A"));

// ============================================
// 4. INDEX STATS
// ============================================

print("\n=== Index statistics ===");
var stats = db.products.aggregate([
  { $indexStats: {} }
]).toArray();

stats.forEach(function(stat) {
  if (stat.name === "idx_codigoBarra" || stat.name === "idx_proveedor_descripcion") {
    print("\nIndex: " + stat.name);
    print("  Accesses: " + stat.accesses.ops);
    print("  Since: " + stat.accesses.since);
  }
});

print("\n=== Migration completed successfully ===");
