'use strict';
// Generates a SAMPLE dataset for development/testing only.
// Contains intentional duplicates, spelling variations, missing/invalid
// identifiers, conflicting data and stale records to exercise every engine.
const ExcelJS = require('exceljs');
const path = require('path');

async function main() {
  const wb = new ExcelJS.Workbook();

  // ---------------- Vendors/Customers sheet ----------------
  const vendors = wb.addWorksheet('SAMPLE_Vendors');
  vendors.addRow(['Vendor Name', 'GSTIN', 'PAN', 'Phone', 'Email', 'Address', 'Vendor Code', 'Created Date', 'Last Modified']);
  const vendorRows = [
    ['ABC Industries Pvt Ltd', '27AAAAA0000A1Z5', 'AAAAA0000A', '9876543210', 'contact@abcind.com', '12 MG Road, Pune', 'V-1001', '2019-02-14', '2021-06-03'],
    ['ABC Industries Pvt. Ltd.', '27AAAAA0000A1Z5', 'AAAAA0000A', '9876543210', 'contact@abcind.com', '12 MG Road, Pune', 'V-1002', '2019-03-01', '2024-11-20'],
    ['A.B.C Industries', '27AAAAA0000A1Z5', '', '9876543210', '', '12, MG Road Pune', 'V-1050', '', ''],
    ['ABC Industires Private Limited', '', 'AAAAA0000A', '9876543210', 'contact@abcind.com', '12 MG Road, Pune', 'V-1090', '2020-01-10', '2020-01-15'],
    ['XYZ Traders', '29BBBBB1111B2Z6', 'BBBBB1111B', '8765432109', 'info@xyztraders.in', '45 Anna Salai, Chennai', 'V-2001', '2022-05-01', '2026-08-01'],
    ['XYZ Traders Ltd', '29BBBBB1111B2Z6', 'BBBBB1111B', '8765432100', 'info@xyztraders.in', '45 Anna Salai, Chennai', 'V-2002', '2022-05-10', '2026-08-15'],
    ['Global Textile Mills', '24CCCCC2222C3Z7', 'CCCCC2222C', '7654321098', 'sales@globaltextile.com', 'Ring Road, Ahmedabad', 'V-3001', '2015-07-20', '2016-01-05'],
    ['Global Textiles Mills Pvt Ltd', '24CCCCC2222C3Z7', 'CCCCC2222C', '7654321098', 'sales@globaltextile.com', 'Ring Road, Ahmedabad', 'V-3050', '2015-08-01', '2016-02-10'],
    ['Sunrise Enterprises', 'INVALIDGSTIN123', 'DDDDD3333D', '9988776655', 'not-an-email', 'Sector 18, Noida', 'V-4001', '2023-01-01', '2023-01-01'],
    ['Blue Ocean Logistics', '19EEEEE4444E5Z9', 'EEEEE4444E', '9123456780', 'ops@blueocean.com', 'Salt Lake, Kolkata', 'V-5001', '2018-11-11', '2018-11-11'],
    ['Blue Ocean Logistics Pvt Ltd', '19EEEEE4444E5Z9', 'FFFFF5555F', '9123456780', 'ops@blueocean.com', 'Salt Lake, Kolkata', 'V-5050', '2021-01-01', '2021-06-06'],
    ['Prakash Steel Corp', '', '', '', '', '', 'V-6001', '2027-01-01', ''], // future date + fully missing identifiers
    ['Sunrise Enterprises', '27GGGGG6666G7Z1', 'DDDDD3333D', '9988776600', 'contact@sunrise.co.in', 'Sector 18, Noida', 'V-4055', '2023-02-01', '2023-02-01'], // same phone family, different GSTIN -> conflict-ish
    ['Meridian Auto Parts', '33HHHHH7777H8Z2', 'HHHHH7777H', '9012345678', 'sales@meridianauto.com', 'Peenya, Bengaluru', 'V-7001', '2013-03-03', '2013-03-03'], // very stale
    ['Nandan Agro Foods', '10IIIII8888I9Z3', 'IIIII8888I', '9012345000', 'hello@nandanagro.com', 'MIDC, Nagpur', 'V-8001', '2024-01-01', '2026-09-01'],
  ];
  vendorRows.forEach(r => vendors.addRow(r));

  // ---------------- Items/Materials sheet ----------------
  const items = wb.addWorksheet('SAMPLE_Items');
  items.addRow(['Item Code', 'Item Description', 'Created Date', 'Last Modified']);
  const itemRows = [
    ['STL-2MM-001', 'Steel Sheet 2mm', '2020-01-01', '2020-06-01'],
    ['STL-2MM-002', 'Steel Sheet - 2 MM', '2020-02-01', '2020-06-15'],
    ['STL-2MM-003', '2mm Steel Sheet', '2020-03-01', '2020-07-01'],
    ['STL-3MM-001', 'Steel Sheet 3mm', '2020-01-05', '2020-06-01'],
    ['CU-WIRE-01', 'Copper Wire 1.5 sq mm', '2019-05-01', '2019-05-01'],
    ['CU-WIRE-02', 'Copper Wire 1.5sqmm', '2019-06-01', '2021-01-01'],
    ['BRG-6205-A', 'Ball Bearing 6205', '2021-01-01', '2026-09-10'],
    ['BRG-6205-B', 'Bearing 6205 Ball Type', '2021-02-01', '2026-09-11'],
    ['PVC-PIPE-20', 'PVC Pipe 20mm', '2018-01-01', '2018-01-01'],
    ['PVC-PIPE-25', 'PVC Pipe 25mm', '2018-01-01', '2018-01-01'], // genuinely different, must not cluster with 20mm
  ];
  itemRows.forEach(r => items.addRow(r));

  wb.getWorksheet('SAMPLE_Vendors').getRow(1).font = { bold: true };
  wb.getWorksheet('SAMPLE_Items').getRow(1).font = { bold: true };

  const outPath = path.join(__dirname, '..', 'sample-data', 'SAMPLE_erp_export.xlsx');
  require('fs').mkdirSync(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  console.log('Sample dataset written to', outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
