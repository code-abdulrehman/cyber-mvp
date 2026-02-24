const express = require("express");
const { faker } = require("@faker-js/faker");

const app = express();
app.use(express.json());

app.get("/admin", (req, res) => {
  res.json({
    id: faker.number.int({ min: 1, max: 1000000 }),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    role: "admin",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/users", (req, res) => {
  const users = Array.from({ length: 10 }).map(() => ({
    id: faker.number.int({ min: 1, max: 1000000 }),
    name: faker.person.fullName(),
    email: faker.internet.email(),
    role: "user",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));
  res.json(users);
});

app.listen(4000, () => {
  console.log("Sandbox running on port 4000");
});